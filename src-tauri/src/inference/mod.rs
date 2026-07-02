//! Local-AI inference stack (Sales Accelerator tier).
//!
//! Mirrors Ragtag's proven architecture — see `docs/UPCELLS_INFERENCE_NOTES.md` (§2–4)
//! and `docs/sales-accelerator/PLAN.md`. In-process GGUF inference via `llama-cpp-2`,
//! one binary, 100% local, no cloud fallback.
//!
//! **Phase 0 scaffolding.** Module structure and types are in place. The pure pieces —
//! the model catalogue ([`model_registry`]), the hardware→model recommendation logic
//! ([`recommend`]), and event-name sanitisation ([`stream`]) — are implemented for real.
//! The parts that need not-yet-added native crates (`llama-cpp-2`, `sysinfo`,
//! `nvml-wrapper`, `ash`) return `INFERENCE_ERROR` "not yet implemented" until those
//! deps land: [`engine`], [`hardware`], [`model_downloader`].
#![allow(dead_code)] // scaffolding — items are wired up incrementally through Phase 0

pub mod engine;
pub mod hardware;
pub mod model_downloader;
pub mod model_registry;
pub mod recommend;
pub mod stream;
