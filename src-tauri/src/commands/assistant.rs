//! Sales Accelerator commands — local-AI hardware probing and model catalogue.
//!
//! Phase 0: hardware detection + catalogue + recommendation are live. Inference/generation
//! commands arrive with the engine (step 2b).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

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
    fn get_or_init(&self) -> AppResult<Arc<InferenceEngine>> {
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
    fn current(&self) -> Option<Arc<InferenceEngine>> {
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
