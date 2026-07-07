//! Sales Accelerator: knowledge base (RAG) commands — ingest sources, list/delete, and write
//! prospecting content grounded in the rep's own material.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::assistant::AiState;
use crate::data_pool::query::generate_clean;
use crate::db::models::KnowledgeSource;
use crate::db::DbConnection;
use crate::error::{AppError, AppResult};
use crate::inference::model_downloader::{self, DownloadProgress};
use crate::inference::model_registry;
use crate::inference::stream::download_event;
use crate::knowledge::{extract, ingest, store};

const EMBEDDING_MODEL_ID: &str = "nomic-embed-text-v1.5-q8";
/// Passages retrieved to ground a prospecting draft.
const RETRIEVE_K: usize = 6;

/// Progress payload emitted on `knowledge:progress` while a source is ingested.
#[derive(Debug, Clone, Serialize)]
pub struct KnowledgeProgress {
    pub done: usize,
    pub total: usize,
}

/// A cited passage behind a prospecting draft.
#[derive(Debug, Clone, Serialize)]
pub struct Citation {
    pub source_id: String,
    pub source_name: String,
    pub snippet: String,
}

/// A generated prospecting draft grounded in the rep's material.
#[derive(Debug, Clone, Serialize)]
pub struct ProspectingResult {
    pub content: String,
    pub citations: Vec<Citation>,
}

fn models_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::io(format!("app data dir unavailable: {e}")))?;
    Ok(dir.join("models"))
}

/// Ensure the nomic embedding model is downloaded and loaded into the embedding slot. Downloads
/// on first use (small, ~140 MB), streaming progress on `model:download:{id}`.
async fn ensure_embedding_model(app: &AppHandle, ai: &Arc<AiState>) -> AppResult<()> {
    let entry = model_registry::find(EMBEDDING_MODEL_ID)
        .ok_or_else(|| AppError::inference("embedding model missing from catalogue"))?;
    let dir = models_dir(app)?;
    std::fs::create_dir_all(&dir).ok();
    let dest = model_downloader::model_path(&dir, entry);

    if !dest.exists() {
        let event = download_event(EMBEDDING_MODEL_ID);
        let app_progress = app.clone();
        let cancel = AtomicBool::new(false);
        model_downloader::download_model(entry, &dir, &cancel, |downloaded, total| {
            let _ = app_progress.emit(
                &event,
                DownloadProgress { model_id: EMBEDDING_MODEL_ID.to_string(), downloaded, total },
            );
        })
        .await?;
    }

    let ai = ai.clone();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let engine = ai.get_or_init()?;
        if !engine.is_embedding_model_loaded(EMBEDDING_MODEL_ID) {
            engine.load_embedding_model(EMBEDDING_MODEL_ID, &dest)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::inference(format!("embedding load task failed: {e}")))??;
    Ok(())
}

/// Add a file as a knowledge source (extract → chunk → embed → store).
#[tauri::command]
pub async fn add_knowledge_file(
    app: AppHandle,
    db: State<'_, DbConnection>,
    state: State<'_, Arc<AiState>>,
    file_path: String,
) -> Result<KnowledgeSource, AppError> {
    ensure_embedding_model(&app, state.inner()).await?;
    let ai = state.inner().clone();
    let db_arc = db.inner().clone();
    let app_progress = app.clone();

    let id = uuid::Uuid::new_v4().to_string();
    let path = PathBuf::from(&file_path);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Document")
        .to_string();
    let (id_task, name_task, loc) = (id.clone(), name.clone(), file_path.clone());

    let (chunk_count, created_at) = tokio::task::spawn_blocking(move || -> AppResult<(usize, i64)> {
        let engine = ai.get_or_init()?;
        let text = extract::extract_file(&path)?;
        let chunks = ingest::embed_chunks(&engine, &text, |done, total| {
            let _ = app_progress.emit("knowledge:progress", KnowledgeProgress { done, total });
        })?;
        let conn = db_arc.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        let created_at = ingest::store_source(&conn, &id_task, &name_task, "file", Some(&loc), &chunks)?;
        Ok((chunks.len(), created_at))
    })
    .await
    .map_err(|e| AppError::inference(format!("ingest task failed: {e}")))??;

    Ok(KnowledgeSource {
        id,
        name,
        kind: "file".into(),
        location: Some(file_path),
        chunk_count: chunk_count as i64,
        created_at,
    })
}

/// Add a web page as a knowledge source (fetch + readability → chunk → embed → store).
#[tauri::command]
pub async fn add_knowledge_url(
    app: AppHandle,
    db: State<'_, DbConnection>,
    state: State<'_, Arc<AiState>>,
    url: String,
) -> Result<KnowledgeSource, AppError> {
    ensure_embedding_model(&app, state.inner()).await?;
    let (name, text) = extract::extract_url(&url).await?;

    let ai = state.inner().clone();
    let db_arc = db.inner().clone();
    let app_progress = app.clone();
    let id = uuid::Uuid::new_v4().to_string();
    let (id_task, name_task, loc) = (id.clone(), name.clone(), url.clone());

    let (chunk_count, created_at) = tokio::task::spawn_blocking(move || -> AppResult<(usize, i64)> {
        let engine = ai.get_or_init()?;
        let chunks = ingest::embed_chunks(&engine, &text, |done, total| {
            let _ = app_progress.emit("knowledge:progress", KnowledgeProgress { done, total });
        })?;
        let conn = db_arc.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
        let created_at = ingest::store_source(&conn, &id_task, &name_task, "url", Some(&loc), &chunks)?;
        Ok((chunks.len(), created_at))
    })
    .await
    .map_err(|e| AppError::inference(format!("ingest task failed: {e}")))??;

    Ok(KnowledgeSource {
        id,
        name,
        kind: "url".into(),
        location: Some(url),
        chunk_count: chunk_count as i64,
        created_at,
    })
}

/// List knowledge sources, newest first.
#[tauri::command]
pub async fn list_knowledge_sources(
    db: State<'_, DbConnection>,
) -> Result<Vec<KnowledgeSource>, AppError> {
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, location, chunk_count, created_at \
             FROM knowledge_sources ORDER BY created_at DESC",
        )
        .map_err(|e| AppError::db(format!("failed to list sources: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(KnowledgeSource {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                location: r.get(3)?,
                chunk_count: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| AppError::db(format!("failed to read sources: {e}")))?;
    rows.collect::<Result<_, _>>()
        .map_err(|e| AppError::db(format!("failed to read sources: {e}")))
}

/// Delete a knowledge source and its chunks/vectors.
#[tauri::command]
pub async fn delete_knowledge_source(
    db: State<'_, DbConnection>,
    source_id: String,
) -> Result<(), AppError> {
    let conn = db.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
    store::delete_source_chunks(&conn, &source_id)
        .map_err(|e| AppError::db(format!("failed to delete chunks: {e}")))?;
    conn.execute(
        "DELETE FROM knowledge_sources WHERE id = ?1",
        rusqlite::params![source_id],
    )
    .map_err(|e| AppError::db(format!("failed to delete source: {e}")))?;
    Ok(())
}

/// Write prospecting content grounded in the retrieved source material, with citations.
#[tauri::command]
pub async fn write_prospecting(
    app: AppHandle,
    db: State<'_, DbConnection>,
    state: State<'_, Arc<AiState>>,
    brief: String,
) -> Result<ProspectingResult, AppError> {
    ensure_embedding_model(&app, state.inner()).await?;
    let ai = state.inner().clone();
    let db_arc = db.inner().clone();

    let result = tokio::task::spawn_blocking(move || -> AppResult<ProspectingResult> {
        let engine = ai.get_or_init()?;

        // Retrieve passages + their source names, then release the DB lock before generating.
        let passages: Vec<(String, String, String)> = {
            let conn = db_arc.lock().map_err(|_| AppError::db("DB lock poisoned"))?;
            let hits = ingest::retrieve(&conn, &engine, &brief, RETRIEVE_K)?;
            if hits.is_empty() {
                return Err(AppError::validation(
                    "no source material yet — add some in the knowledge base first",
                ));
            }
            hits.into_iter()
                .map(|h| {
                    let name: String = conn
                        .query_row(
                            "SELECT name FROM knowledge_sources WHERE id = ?1",
                            rusqlite::params![h.source_id],
                            |r| r.get(0),
                        )
                        .unwrap_or_else(|_| "Source".to_string());
                    (h.source_id, name, h.text)
                })
                .collect()
        };

        let mut material = String::new();
        for (i, (_id, name, text)) in passages.iter().enumerate() {
            material.push_str(&format!("[{}] ({}): {}\n\n", i + 1, name, text));
        }
        let prompt = format!(
            "You are helping a salesperson with outreach, using ONLY their own product/brand \
             material below. Task: {brief}\n\nGround every claim in the material and cite sources \
             inline like [1], [2]. Do not invent facts. Keep it concise and ready to send.\n\n\
             Material:\n{material}\nDraft:"
        );
        let content = generate_clean(&engine, &prompt, 0.5, 800)?;

        let citations = passages
            .into_iter()
            .map(|(source_id, source_name, text)| Citation {
                source_id,
                source_name,
                snippet: truncate(&text, 200),
            })
            .collect();
        Ok(ProspectingResult { content, citations })
    })
    .await
    .map_err(|e| AppError::inference(format!("prospecting task failed: {e}")))??;

    Ok(result)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        format!("{}…", s.chars().take(max).collect::<String>())
    } else {
        s.to_string()
    }
}
