//! In-process GGUF inference engine (§2).
//!
//! Wraps `llama-cpp-2`: loads GGUF models, keeps them warm behind async-mutex slots,
//! sizes context from hardware ([`resolve_n_ctx`], §2.5), runs the sampler loop, streams
//! tokens through [`crate::inference::stream`], and cancels via an `AtomicBool` checked
//! each token.
//!
//! TODO(phase0): implement once `llama-cpp-2` is added. Until then the load/generate paths
//! return `INFERENCE_ERROR`.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{AppError, AppResult};

/// Sampling parameters for one generation turn.
///
/// The text-to-SQL step uses a fully deterministic profile (temperature 0, seed 0) so the
/// same question yields the same SQL (§1.4); chat/report generation can relax it.
#[derive(Debug, Clone)]
pub struct GenerationParams {
    pub temperature: f32,
    pub top_p: f32,
    pub seed: u32,
    pub max_tokens: u32,
}

impl Default for GenerationParams {
    fn default() -> Self {
        Self { temperature: 0.7, top_p: 0.95, seed: 0, max_tokens: 1024 }
    }
}

impl GenerationParams {
    /// Deterministic profile for text-to-SQL (§1.4).
    pub fn deterministic_sql() -> Self {
        Self { temperature: 0.0, top_p: 1.0, seed: 0, max_tokens: 400 }
    }
}

/// The inference engine. Holds warm model slots for the app session.
///
/// TODO(phase0): real fields — `tokio::sync::Mutex<Option<LoadedModel>>` per role
/// (chat/embedding/rerank), the `llama_cpp_2` backend, and `n_ctx`/`n_batch`.
pub struct InferenceEngine {
    /// Flipped by a "stop" command; checked every token in the sampler loop.
    cancel: AtomicBool,
}

impl InferenceEngine {
    pub fn new() -> Self {
        Self { cancel: AtomicBool::new(false) }
    }

    /// Request cancellation of the in-flight generation. Lock-free, responsive mid-decode.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Whether cancellation has been requested (checked each token by the sampler loop).
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// Clear the cancel flag before starting a new turn.
    pub fn reset_cancel(&self) {
        self.cancel.store(false, Ordering::Relaxed);
    }

    /// Load a catalogue model by id, keeping it warm for the session.
    pub async fn load_model(&self, _model_id: &str) -> AppResult<()> {
        Err(AppError::inference(
            "inference engine not yet implemented (needs llama-cpp-2)",
        ))
    }
}

impl Default for InferenceEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Budget `n_ctx` from total RAM minus weights minus an OS reserve, divided by the model's
/// KV-cache cost per token, clamped to a size-class ceiling, the trained length, and a 4096
/// floor. Uses *total* (not available) RAM for stability across reboots (§2.5).
///
/// TODO(phase0): implement against a loaded model + [`crate::inference::hardware`].
pub fn resolve_n_ctx(_total_ram_bytes: u64, _weights_bytes: u64, _kv_bytes_per_token: u64) -> u32 {
    4096 // floor placeholder
}
