//! In-process GGUF inference engine (§2).
//!
//! Wraps `llama-cpp-2`: initialises the backend once, loads a GGUF model into a warm slot,
//! creates a context per generation, runs the sampler loop, emits each token through an
//! `on_token` callback (which callers bridge to [`crate::inference::stream`] Tauri events),
//! and cancels via an `AtomicBool` checked every token.
//!
//! `LlamaModel` is `Send + Sync`, so a future step can hold this engine in Tauri managed
//! state; the non-`Send` `LlamaContext` is created and dropped inside `generate`, never
//! stored. Wiring generation to an async streaming command is a follow-up (step 2b-ii).

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;

use crate::error::{AppError, AppResult};

/// Sampling parameters for one generation turn.
///
/// The text-to-SQL step uses a fully deterministic profile (temperature 0 → greedy, seed 0)
/// so the same question yields the same SQL (§1.4); chat/report generation can relax it.
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

/// Upper bound on the context we allocate until hardware-aware sizing lands (`resolve_n_ctx`).
const N_CTX_CAP: u32 = 8192;
const N_CTX_FLOOR: u32 = 512;

struct LoadedModel {
    id: String,
    model: LlamaModel,
    /// Context length allocated for this model.
    n_ctx: u32,
}

/// The inference engine. Holds the backend and one warm chat model for the session.
pub struct InferenceEngine {
    backend: LlamaBackend,
    model: Mutex<Option<LoadedModel>>,
    /// Flipped by [`cancel`](Self::cancel); checked every token in the sampler loop.
    cancel: AtomicBool,
}

impl InferenceEngine {
    /// Initialise the llama.cpp backend. Backend init is idempotent per process.
    pub fn new() -> AppResult<Self> {
        let backend = LlamaBackend::init()
            .map_err(|e| AppError::inference(format!("llama backend init failed: {e}")))?;
        Ok(Self {
            backend,
            model: Mutex::new(None),
            cancel: AtomicBool::new(false),
        })
    }

    /// Request cancellation of the in-flight generation. Lock-free, responsive mid-decode.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn reset_cancel(&self) {
        self.cancel.store(false, Ordering::Relaxed);
    }

    /// Whether a model with `id` is already loaded.
    pub fn is_model_loaded(&self, id: &str) -> bool {
        self.model
            .lock()
            .map(|m| m.as_ref().is_some_and(|l| l.id == id))
            .unwrap_or(false)
    }

    /// The id of the currently-loaded model, if any (used to pick model-specific prompt
    /// handling, e.g. the qwen3 think-prefill).
    pub fn loaded_model_id(&self) -> Option<String> {
        self.model
            .lock()
            .ok()
            .and_then(|m| m.as_ref().map(|l| l.id.clone()))
    }

    /// Load a GGUF model into the warm slot, replacing any currently-loaded model. On Apple
    /// Silicon / GPU builds `n_gpu_layers = 999` offloads every layer; on CPU builds it is 0.
    pub fn load_model(&self, id: &str, path: &Path) -> AppResult<()> {
        let model_params = LlamaModelParams::default().with_n_gpu_layers(default_gpu_layers());
        let model = LlamaModel::load_from_file(&self.backend, path, &model_params)
            .map_err(|e| AppError::inference(format!("failed to load model '{id}': {e}")))?;

        let n_ctx = model.n_ctx_train().clamp(N_CTX_FLOOR, N_CTX_CAP);

        let mut slot = self
            .model
            .lock()
            .map_err(|_| AppError::inference("model lock poisoned"))?;
        *slot = Some(LoadedModel { id: id.to_string(), model, n_ctx });
        Ok(())
    }

    /// Generate a completion for `prompt`, invoking `on_token` with each decoded piece as it
    /// streams. Returns the full text. Stops on end-of-generation, `max_tokens`, or cancel.
    pub fn generate(
        &self,
        prompt: &str,
        params: &GenerationParams,
        mut on_token: impl FnMut(&str),
    ) -> AppResult<String> {
        self.reset_cancel();

        let slot = self
            .model
            .lock()
            .map_err(|_| AppError::inference("model lock poisoned"))?;
        let loaded = slot
            .as_ref()
            .ok_or_else(|| AppError::inference("no model loaded"))?;
        let model = &loaded.model;
        let n_ctx = loaded.n_ctx;

        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_batch(n_ctx);
        let mut ctx = model
            .new_context(&self.backend, ctx_params)
            .map_err(|e| AppError::inference(format!("context creation failed: {e}")))?;

        let tokens = model
            .str_to_token(prompt, AddBos::Always)
            .map_err(|e| AppError::inference(format!("tokenize failed: {e}")))?;
        if tokens.is_empty() {
            return Ok(String::new());
        }
        if tokens.len() as u32 >= n_ctx {
            return Err(AppError::inference(format!(
                "prompt ({} tokens) exceeds context window ({n_ctx})",
                tokens.len()
            )));
        }

        // Decode the prompt; request logits only for the final token.
        let mut batch = LlamaBatch::new(n_ctx as usize, 1);
        let last = tokens.len() - 1;
        for (i, token) in tokens.iter().enumerate() {
            batch
                .add(*token, i as i32, &[0], i == last)
                .map_err(|e| AppError::inference(format!("batch add failed: {e}")))?;
        }
        ctx.decode(&mut batch)
            .map_err(|e| AppError::inference(format!("prompt decode failed: {e}")))?;

        let mut sampler = build_sampler(params);

        let mut output = String::new();
        // Rolling byte buffer so multi-byte UTF-8 split across tokens is emitted intact.
        let mut pending: Vec<u8> = Vec::new();
        let mut n_pos = batch.n_tokens();
        for _ in 0..params.max_tokens {
            if self.is_cancelled() {
                break;
            }
            // Sample from the logits of the last token in the current batch.
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);

            if model.is_eog_token(token) {
                break;
            }

            pending.extend_from_slice(&token_bytes(model, token));
            let piece = flush_utf8(&mut pending);
            if !piece.is_empty() {
                output.push_str(&piece);
                on_token(&piece);
            }

            if n_pos as u32 >= n_ctx {
                break; // context full
            }
            batch.clear();
            batch
                .add(token, n_pos, &[0], true)
                .map_err(|e| AppError::inference(format!("batch add failed: {e}")))?;
            n_pos += 1;
            ctx.decode(&mut batch)
                .map_err(|e| AppError::inference(format!("decode failed: {e}")))?;
        }

        // Flush any trailing bytes (e.g. an incomplete final token) lossily.
        if !pending.is_empty() {
            let tail = String::from_utf8_lossy(&pending).into_owned();
            output.push_str(&tail);
            on_token(&tail);
        }

        Ok(output)
    }
}

/// Detokenise one token to bytes (generous buffer avoids the resize round-trip).
fn token_bytes(model: &LlamaModel, token: LlamaToken) -> Vec<u8> {
    model
        .token_to_piece_bytes(token, 256, false, None)
        .unwrap_or_default()
}

/// Split off the longest valid-UTF-8 prefix of `pending`, leaving any trailing incomplete
/// multi-byte sequence in the buffer for the next token.
fn flush_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
    }
}

/// GPU layer offload: all layers on GPU builds (Apple Silicon here), none on CPU builds.
fn default_gpu_layers() -> u32 {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        999 // llama.cpp caps to the model's real layer count = offload all
    } else {
        0
    }
}

/// Build a sampler chain from generation params: greedy when deterministic (temp 0), else a
/// standard top-k → top-p → temperature → distribution chain.
fn build_sampler(params: &GenerationParams) -> LlamaSampler {
    if params.temperature <= 0.0 {
        LlamaSampler::chain_simple([LlamaSampler::greedy()])
    } else {
        LlamaSampler::chain_simple([
            LlamaSampler::top_k(40),
            LlamaSampler::top_p(params.top_p, 1),
            LlamaSampler::temp(params.temperature),
            LlamaSampler::dist(params.seed),
        ])
    }
}

/// Budget `n_ctx` from total RAM minus weights minus an OS reserve, divided by the model's
/// KV-cache cost per token, clamped to a size-class ceiling, the trained length, and a floor.
/// Uses *total* (not available) RAM for stability across reboots (§2.5).
///
/// TODO(step 2b-ii): use this in `load_model` with real weights + [`crate::inference::hardware`].
pub fn resolve_n_ctx(total_ram_bytes: u64, weights_bytes: u64, kv_bytes_per_token: u64) -> u32 {
    if kv_bytes_per_token == 0 {
        return N_CTX_CAP;
    }
    const OS_RESERVE: u64 = 2 * 1024 * 1024 * 1024;
    let available = total_ram_bytes
        .saturating_sub(weights_bytes)
        .saturating_sub(OS_RESERVE);
    let budget_tokens = (available / kv_bytes_per_token) as u32;
    budget_tokens.clamp(N_CTX_FLOOR, N_CTX_CAP)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opt-in end-to-end smoke test — loads a real GGUF and generates a few tokens.
    /// Run with: `UPCELLS_SMOKE_GGUF=/path/to/model.gguf cargo test --lib \
    /// inference::engine -- --ignored --nocapture`
    #[test]
    #[ignore = "requires a local GGUF via UPCELLS_SMOKE_GGUF"]
    fn smoke_load_and_generate() {
        let path = std::env::var("UPCELLS_SMOKE_GGUF")
            .expect("set UPCELLS_SMOKE_GGUF to a .gguf path");
        let engine = InferenceEngine::new().expect("backend init");
        engine
            .load_model("smoke", Path::new(&path))
            .expect("model should load");

        let params = GenerationParams {
            max_tokens: 32,
            ..GenerationParams::deterministic_sql()
        };
        let text = engine
            .generate("Q: What is the capital of France? A:", &params, |tok| {
                eprint!("{tok}");
            })
            .expect("generation should succeed");
        eprintln!("\n[smoke] full output: {text:?}");
        assert!(!text.trim().is_empty(), "should produce non-empty output");
    }
}
