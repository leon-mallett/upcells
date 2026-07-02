//! Sales Accelerator commands — local-AI hardware probing and model catalogue.
//!
//! Phase 0: hardware detection + catalogue + recommendation are live. Inference/generation
//! commands arrive with the engine (step 2b).

use tauri::Manager;

use crate::error::{AppError, AppResult};
use crate::inference::hardware::{self, HardwareInfo};
use crate::inference::model_registry::{ModelEntry, CATALOGUE};
use crate::inference::recommend::{self, Recommendation};

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
