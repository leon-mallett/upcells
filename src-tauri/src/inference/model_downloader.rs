//! Model downloader (§4).
//!
//! Resolves the canonical Hugging Face URL and streams the file with `reqwest` (already a
//! project dep — no `hf-hub`): resumable via `Range` into a `{id}.gguf.partial`, throttled
//! progress callbacks, `AtomicBool` cancel, streaming SHA-256 verify when a hash is pinned,
//! and an atomic rename to the final path only after verification.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};
use crate::inference::model_registry::ModelEntry;

/// Emit a progress event at most once per this many downloaded bytes.
const PROGRESS_STEP: u64 = 256 * 1024;

/// Download-progress payload for `model:download:{id}` events.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub model_id: String,
    pub downloaded: u64,
    /// Total size in bytes, when known (some servers don't report it).
    pub total: Option<u64>,
}

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

fn partial_path(models_dir: &Path, entry: &ModelEntry) -> PathBuf {
    models_dir.join(format!("{}.gguf.partial", entry.id))
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Download a model to `models_dir`, resuming/verifying as described above. Returns the
/// final path. If the model is already present, returns immediately.
pub async fn download_model(
    entry: &ModelEntry,
    models_dir: &Path,
    cancel: &AtomicBool,
    on_progress: impl FnMut(u64, Option<u64>),
) -> AppResult<PathBuf> {
    let dest = model_path(models_dir, entry);
    if dest.exists() {
        return Ok(dest);
    }
    tokio::fs::create_dir_all(models_dir)
        .await
        .map_err(|e| AppError::io(format!("failed to create models dir: {e}")))?;

    let partial = partial_path(models_dir, entry);
    download_to_file(&resolve_url(entry), &partial, &dest, entry.sha256, cancel, on_progress).await?;
    Ok(dest)
}

/// Stream `url` into `partial`, verify against `expected_sha` if given, then atomically
/// rename to `dest`. Resumes from any existing `partial` via a `Range` request.
async fn download_to_file(
    url: &str,
    partial: &Path,
    dest: &Path,
    expected_sha: Option<&str>,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> AppResult<()> {
    let mut offset = tokio::fs::metadata(partial).await.map(|m| m.len()).unwrap_or(0);

    let client = reqwest::Client::new();
    let mut request = client.get(url);
    if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|e| AppError::api(format!("download request failed: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::api(format!("download failed: {e}")))?;

    // If we asked to resume but the server sent the whole file (200, not 206), start over.
    let resuming = offset > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if offset > 0 && !resuming {
        offset = 0;
    }
    let total = response
        .content_length()
        .map(|len| if resuming { offset + len } else { len });

    let mut hasher = Sha256::new();
    if resuming {
        let existing = tokio::fs::read(partial)
            .await
            .map_err(|e| AppError::io(format!("failed to read partial download: {e}")))?;
        hasher.update(&existing);
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resuming)
        .truncate(!resuming)
        .open(partial)
        .await
        .map_err(|e| AppError::io(format!("failed to open partial file: {e}")))?;

    let mut downloaded = offset;
    let mut since_emit = 0u64;
    on_progress(downloaded, total);

    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AppError::api(format!("download stream error: {e}")))?
    {
        if cancel.load(Ordering::Relaxed) {
            // Leave the .partial in place so a retry resumes.
            return Err(AppError::inference("download cancelled"));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| AppError::io(format!("failed writing download: {e}")))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        since_emit += chunk.len() as u64;
        if since_emit >= PROGRESS_STEP {
            since_emit = 0;
            on_progress(downloaded, total);
        }
    }
    file.flush()
        .await
        .map_err(|e| AppError::io(format!("failed to flush download: {e}")))?;
    drop(file);
    on_progress(downloaded, total);

    if let Some(expected) = expected_sha {
        let actual = to_hex(&hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(partial).await;
            return Err(AppError::inference(format!(
                "sha256 mismatch (expected {expected}, got {actual})"
            )));
        }
    }

    tokio::fs::rename(partial, dest)
        .await
        .map_err(|e| AppError::io(format!("failed to finalise download: {e}")))?;
    Ok(())
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

    #[test]
    fn hex_encodes_sha256_of_abc() {
        let digest = Sha256::digest(b"abc");
        assert_eq!(
            to_hex(&digest),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// Opt-in: exercises the real network + resume + rename path against a small file.
    #[tokio::test]
    #[ignore = "network"]
    async fn downloads_a_small_file() {
        let dir = std::env::temp_dir().join("upcells-dl-test");
        let partial = dir.join("t.partial");
        let dest = dir.join("t.bin");
        let _ = tokio::fs::create_dir_all(&dir).await;
        let _ = tokio::fs::remove_file(&dest).await;
        let cancel = AtomicBool::new(false);
        download_to_file(
            "https://raw.githubusercontent.com/rust-lang/rust/master/README.md",
            &partial,
            &dest,
            None,
            &cancel,
            |_d, _t| {},
        )
        .await
        .expect("download should succeed");
        let meta = tokio::fs::metadata(&dest).await.expect("dest should exist");
        assert!(meta.len() > 0, "downloaded file should be non-empty");
    }
}
