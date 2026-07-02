//! Model downloader (§4).
//!
//! Resolves the canonical Hugging Face URL and streams the file with `reqwest` (already a
//! project dep — no `hf-hub`): resumable via `Range` into a `{id}.{ext}.partial`, throttled
//! progress events, `AtomicBool` cancel, streaming SHA-256 verify when a hash is pinned, and
//! an atomic rename to the final path only after verification.
//!
//! TODO(phase0): implement the transfer. [`hugging_face_url`] is done and used by callers.

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::inference::model_registry::ModelEntry;

/// The canonical HF resolve URL for a repo + file (main branch).
pub fn hugging_face_url(repo: &str, file: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/main/{file}")
}

/// The download URL for a catalogue entry — its override if set, else the HF resolve URL.
pub fn resolve_url(entry: &ModelEntry) -> String {
    entry
        .download_url
        .map(str::to_string)
        .unwrap_or_else(|| hugging_face_url(entry.hugging_face_repo, entry.hugging_face_file))
}

/// On-disk path for a downloaded model: `{models_dir}/{id}.gguf`.
pub fn model_path(models_dir: &Path, entry: &ModelEntry) -> PathBuf {
    models_dir.join(format!("{}.gguf", entry.id))
}

/// Download a model to `models_dir`, resuming/verifying as described above.
pub async fn download_model(_entry: &ModelEntry, _models_dir: &Path) -> AppResult<PathBuf> {
    Err(AppError::inference("model downloader not yet implemented"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_canonical_hf_url() {
        assert_eq!(
            hugging_face_url("Qwen/Qwen3.5-4B-GGUF", "Qwen3.5-4B-Q4_K_M.gguf"),
            "https://huggingface.co/Qwen/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf"
        );
    }
}
