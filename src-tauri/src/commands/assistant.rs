//! Sales Accelerator commands — local-AI hardware probing and model catalogue.
//!
//! Phase 0: hardware detection + catalogue + recommendation are live. Inference/generation
//! commands arrive with the engine (step 2b).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::data_pool::import::{import_csv, import_rows, import_xlsx};
use crate::data_pool::query::{answer_question, narrate, PriorTurn};
use crate::data_pool::report::{self, Report};
use crate::data_pool::schema::capture_schema;
use crate::data_pool::{self};
use crate::db::models::DataPool;
use crate::db::DbConnection;
use crate::error::{AppError, AppResult};
use crate::inference::engine::{GenerationParams, InferenceEngine};
use crate::inference::hardware::{self, HardwareInfo};
use crate::inference::model_downloader::{self, DownloadProgress};
use crate::inference::model_registry::{self, ModelEntry, CATALOGUE};
use crate::inference::recommend::{self, Recommendation};
use crate::inference::stream::{
    complete_event, download_event, stream_event, GenerationComplete, StreamChunk,
};

/// Managed state holding the lazily-initialised inference engine, so the (potentially slow,
/// Metal-compiling) backend init is deferred until a user first uses the Sales Accelerator.
#[derive(Default)]
pub struct AiState {
    engine: Mutex<Option<Arc<InferenceEngine>>>,
    /// Set to request cancellation of an in-flight model download.
    download_cancel: AtomicBool,
}

impl AiState {
    /// Get the engine, initialising the backend on first use.
    pub(crate) fn get_or_init(&self) -> AppResult<Arc<InferenceEngine>> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| AppError::inference("ai state poisoned"))?;
        if let Some(engine) = guard.as_ref() {
            return Ok(engine.clone());
        }
        let engine = Arc::new(InferenceEngine::new()?);
        *guard = Some(engine.clone());
        Ok(engine)
    }

    /// The engine if already initialised (does not init — used by cancel).
    pub(crate) fn current(&self) -> Option<Arc<InferenceEngine>> {
        self.engine.lock().ok().and_then(|g| g.clone())
    }
}

/// The directory that holds downloaded models (used to report the right volume's free space).
fn models_dir(app: &tauri::AppHandle) -> AppResult<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::io(format!("app data dir unavailable: {e}")))?;
    Ok(dir.join("models"))
}

/// Detect this machine's capabilities (RAM/CPU/free-disk/GPU).
#[tauri::command]
pub fn get_ai_hardware_info(app: tauri::AppHandle) -> Result<HardwareInfo, AppError> {
    let dir = models_dir(&app)?;
    hardware::detect(&dir)
}

/// The curated model catalogue.
#[tauri::command]
pub fn list_ai_models() -> Vec<ModelEntry> {
    CATALOGUE.to_vec()
}

/// Recommend a chat model for this machine, with a tier + rationale.
#[tauri::command]
pub fn recommend_ai_model(app: tauri::AppHandle) -> Result<Recommendation, AppError> {
    let dir = models_dir(&app)?;
    let hw = hardware::detect(&dir)?;
    Ok(recommend::recommend_chat(&hw))
}

/// Download a catalogue model, streaming progress to `model:download:{modelId}` events.
/// Resumable and SHA-256-verified; returns once the model is on disk.
#[tauri::command]
pub async fn download_ai_model(
    app: AppHandle,
    state: State<'_, Arc<AiState>>,
    model_id: String,
) -> Result<(), AppError> {
    let entry = model_registry::find(&model_id)
        .ok_or_else(|| AppError::validation(format!("unknown model '{model_id}'")))?;
    let dir = models_dir(&app)?;
    let ai = state.inner().clone();
    ai.download_cancel.store(false, Ordering::Relaxed);

    let event = download_event(&model_id);
    let app_progress = app.clone();
    let mid = model_id.clone();
    model_downloader::download_model(entry, &dir, &ai.download_cancel, move |downloaded, total| {
        let _ = app_progress.emit(
            &event,
            DownloadProgress { model_id: mid.clone(), downloaded, total },
        );
    })
    .await
    .map(|_| ())
}

/// Cancel an in-flight model download (the partial file is kept so a retry resumes).
#[tauri::command]
pub fn cancel_ai_download(state: State<'_, Arc<AiState>>) {
    state.download_cancel.store(true, Ordering::Relaxed);
}

/// Load a downloaded model into the engine (initialising the backend on first use). The
/// model file must already exist at `{models_dir}/{model_id}.gguf`.
#[tauri::command]
pub async fn load_ai_model(
    app: AppHandle,
    state: State<'_, Arc<AiState>>,
    model_id: String,
) -> Result<(), AppError> {
    let ai = state.inner().clone();
    let path = models_dir(&app)?.join(format!("{model_id}.gguf"));
    if !path.exists() {
        return Err(AppError::inference(format!(
            "model '{model_id}' is not downloaded"
        )));
    }
    // Model loading is heavy (seconds) — run off the async runtime.
    tokio::task::spawn_blocking(move || ai.get_or_init()?.load_model(&model_id, &path))
        .await
        .map_err(|e| AppError::inference(format!("model load task failed: {e}")))?
}

/// Generate a completion, streaming tokens to `chat:stream:{conversationId}` and a terminal
/// `chat:complete:{conversationId}` event. Returns the assembled message. A model must have
/// been loaded via [`load_ai_model`] first.
#[tauri::command]
pub async fn generate_ai(
    app: AppHandle,
    state: State<'_, Arc<AiState>>,
    conversation_id: String,
    prompt: String,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
) -> Result<GenerationComplete, AppError> {
    let ai = state.inner().clone();
    let params = GenerationParams {
        temperature: temperature.unwrap_or(0.7),
        max_tokens: max_tokens.unwrap_or(1024),
        ..GenerationParams::default()
    };

    let message_id = uuid::Uuid::new_v4().to_string();
    let stream_ev = stream_event(&conversation_id);
    let complete_ev = complete_event(&conversation_id);

    let app_tokens = app.clone();
    let mid = message_id.clone();
    let text = tokio::task::spawn_blocking(move || -> AppResult<String> {
        let engine = ai.get_or_init()?;
        engine.generate(&prompt, &params, move |piece| {
            let _ = app_tokens.emit(
                &stream_ev,
                StreamChunk {
                    message_id: mid.clone(),
                    delta: piece.to_string(),
                    done: false,
                },
            );
        })
    })
    .await
    .map_err(|e| AppError::inference(format!("generation task failed: {e}")))??;

    let complete = GenerationComplete { message_id, text };
    let _ = app.emit(&complete_ev, complete.clone());
    Ok(complete)
}

/// Request cancellation of the in-flight generation (no-op if none / engine not initialised).
#[tauri::command]
pub fn cancel_ai_generation(state: State<'_, Arc<AiState>>) {
    if let Some(engine) = state.current() {
        engine.cancel();
    }
}

/// The id of the currently-loaded (active) model, if any — so the Assistant knows a model
/// activated in Settings is ready.
#[tauri::command]
pub fn get_active_ai_model(state: State<'_, Arc<AiState>>) -> Option<String> {
    state.current().and_then(|engine| engine.loaded_model_id())
}

/// Progress payload emitted on the `report:progress` event while a report is generated.
#[derive(Debug, Clone, Serialize)]
pub struct ReportProgress {
    pub step: String,
}

/// Generate a report over a pool from a template id or a freeform request. Emits progress on
/// the `report:progress` event as it computes each metric.
#[tauri::command]
pub async fn generate_report(
    app: AppHandle,
    db: State<'_, DbConnection>,
    state: State<'_, Arc<AiState>>,
    pool_id: String,
    template: Option<String>,
    request: Option<String>,
) -> Result<Report, AppError> {
    {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        let exists = conn
            .query_row(
                "SELECT 1 FROM data_pools WHERE id = ?1",
                rusqlite::params![pool_id],
                |_| Ok(()),
            )
            .is_ok();
        if !exists {
            return Err(AppError::validation("data pool not found"));
        }
    }
    let pool_db = data_pool::pool_path(&pools_dir(&app)?, &pool_id);
    let ai = state.inner().clone();
    let app_progress = app.clone();

    let report = tokio::task::spawn_blocking(move || -> AppResult<Report> {
        let engine = ai.get_or_init()?;
        let schema = capture_schema(&pool_db)?;
        let (title, metrics): (String, Vec<String>) = if let Some(t) = template.as_deref() {
            let (title, m) = report::template_metrics(t)
                .ok_or_else(|| AppError::validation("unknown report template"))?;
            (title.to_string(), m.into_iter().map(str::to_string).collect())
        } else if let Some(r) = request.as_deref() {
            (r.to_string(), report::derive_metrics(&engine, &schema, r)?)
        } else {
            return Err(AppError::validation("provide a template or a request"));
        };
        report::generate_report(&engine, &pool_db, &schema, &title, &metrics, |step| {
            let _ = app_progress.emit("report:progress", ReportProgress { step: step.to_string() });
        })
    })
    .await
    .map_err(|e| AppError::inference(format!("report task failed: {e}")))??;

    Ok(report)
}

// ── Data pools ───────────────────────────────────────────────────────────────

/// Where pool DuckDB files live.
fn pools_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::io(format!("app data dir unavailable: {e}")))?;
    Ok(dir.join("pools"))
}

/// A text-to-SQL answer: the plain-English answer plus the SQL and result rows behind it,
/// so the UI can show exactly how the number was computed (auditable).
#[derive(Debug, Clone, Serialize)]
pub struct PoolAnswer {
    pub sql: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
    pub answer: String,
}

/// Create a data pool by importing a CSV/XLSX file into a new DuckDB database.
#[tauri::command]
pub async fn create_data_pool(
    app: AppHandle,
    db: State<'_, DbConnection>,
    name: String,
    file_path: String,
) -> Result<DataPool, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let pools = pools_dir(&app)?;
    std::fs::create_dir_all(&pools)
        .map_err(|e| AppError::io(format!("failed to create pools dir: {e}")))?;
    let pool_db = data_pool::pool_path(&pools, &id);

    let table = name.clone();
    let src = file_path.clone();
    let pool_db_for_task = pool_db.clone();
    let summary = tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&src);
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        match ext.as_str() {
            "csv" => import_csv(&pool_db_for_task, &table, path),
            "xlsx" | "xls" | "xlsm" => import_xlsx(&pool_db_for_task, &table, path),
            _ => Err(AppError::validation("unsupported file type — use .csv or .xlsx")),
        }
    })
    .await
    .map_err(|e| AppError::inference(format!("import task failed: {e}")))??;

    let created_at = chrono::Utc::now().timestamp();
    let columns_json = serde_json::to_string(&summary.columns).unwrap_or_else(|_| "[]".into());
    {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        conn.execute(
            "INSERT INTO data_pools \
             (id, name, table_name, source_file, row_count, columns_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                id,
                name,
                summary.table,
                file_path,
                summary.row_count as i64,
                columns_json,
                created_at
            ],
        )
        .map_err(|e| AppError::db(format!("failed to save pool: {e}")))?;
    }

    Ok(DataPool {
        id,
        name,
        table_name: summary.table,
        source_file: Some(file_path),
        row_count: summary.row_count as i64,
        columns: summary.columns,
        created_at,
    })
}

/// Create a data pool directly from Salesforce query results — the primary path (run a query,
/// then save the results as a pool without a file round-trip).
#[tauri::command]
pub async fn create_data_pool_from_results(
    app: AppHandle,
    db: State<'_, DbConnection>,
    name: String,
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
) -> Result<DataPool, AppError> {
    if rows.is_empty() {
        return Err(AppError::validation("no rows to save — run a query first"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let pools = pools_dir(&app)?;
    std::fs::create_dir_all(&pools)
        .map_err(|e| AppError::io(format!("failed to create pools dir: {e}")))?;
    let pool_db = data_pool::pool_path(&pools, &id);

    let table = name.clone();
    let pool_db_for_task = pool_db.clone();
    let summary = tokio::task::spawn_blocking(move || {
        import_rows(&pool_db_for_task, &table, columns, rows)
    })
    .await
    .map_err(|e| AppError::inference(format!("import task failed: {e}")))??;

    let created_at = chrono::Utc::now().timestamp();
    let columns_json = serde_json::to_string(&summary.columns).unwrap_or_else(|_| "[]".into());
    const SOURCE: &str = "Salesforce query";
    {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        conn.execute(
            "INSERT INTO data_pools \
             (id, name, table_name, source_file, row_count, columns_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                id,
                name,
                summary.table,
                SOURCE,
                summary.row_count as i64,
                columns_json,
                created_at
            ],
        )
        .map_err(|e| AppError::db(format!("failed to save pool: {e}")))?;
    }

    Ok(DataPool {
        id,
        name,
        table_name: summary.table,
        source_file: Some(SOURCE.to_string()),
        row_count: summary.row_count as i64,
        columns: summary.columns,
        created_at,
    })
}

/// List all data pools, newest first.
#[tauri::command]
pub async fn list_data_pools(db: State<'_, DbConnection>) -> Result<Vec<DataPool>, AppError> {
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, table_name, source_file, row_count, columns_json, created_at \
             FROM data_pools ORDER BY created_at DESC",
        )
        .map_err(|e| AppError::db(format!("failed to list pools: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            let columns_json: String = r.get(5)?;
            Ok(DataPool {
                id: r.get(0)?,
                name: r.get(1)?,
                table_name: r.get(2)?,
                source_file: r.get(3)?,
                row_count: r.get(4)?,
                columns: serde_json::from_str(&columns_json).unwrap_or_default(),
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| AppError::db(format!("failed to read pools: {e}")))?;
    rows.collect::<Result<_, _>>()
        .map_err(|e| AppError::db(format!("failed to read pools: {e}")))
}

/// Delete a data pool and its DuckDB file.
#[tauri::command]
pub async fn delete_data_pool(
    app: AppHandle,
    db: State<'_, DbConnection>,
    pool_id: String,
) -> Result<(), AppError> {
    {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        conn.execute("DELETE FROM data_pools WHERE id = ?1", rusqlite::params![pool_id])
            .map_err(|e| AppError::db(format!("failed to delete pool: {e}")))?;
    }
    let pool_db = data_pool::pool_path(&pools_dir(&app)?, &pool_id);
    let _ = std::fs::remove_file(&pool_db);
    let _ = std::fs::remove_file(pool_db.with_extension("duckdb.wal"));
    Ok(())
}

/// Ask a natural-language question of a pool: generate SQL, run it read-only, and narrate the
/// result. A model must have been loaded via [`load_ai_model`] first.
#[tauri::command]
pub async fn ask_data_pool(
    app: AppHandle,
    db: State<'_, DbConnection>,
    state: State<'_, Arc<AiState>>,
    pool_id: String,
    question: String,
    history: Vec<PriorTurn>,
) -> Result<PoolAnswer, AppError> {
    {
        let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        let exists = conn
            .query_row(
                "SELECT 1 FROM data_pools WHERE id = ?1",
                rusqlite::params![pool_id],
                |_| Ok(()),
            )
            .is_ok();
        if !exists {
            return Err(AppError::validation("data pool not found"));
        }
    }
    let pool_db = data_pool::pool_path(&pools_dir(&app)?, &pool_id);
    let ai = state.inner().clone();

    let (result, answer) = tokio::task::spawn_blocking(move || -> AppResult<_> {
        let engine = ai.get_or_init()?;
        let schema = capture_schema(&pool_db)?;
        let result = answer_question(&engine, &pool_db, &schema, &question, &history)?;
        let answer = narrate(&engine, &question, &result)?;
        Ok((result, answer))
    })
    .await
    .map_err(|e| AppError::inference(format!("query task failed: {e}")))??;

    Ok(PoolAnswer {
        sql: result.sql,
        columns: result.columns,
        rows: result.rows,
        truncated: result.truncated,
        answer,
    })
}
