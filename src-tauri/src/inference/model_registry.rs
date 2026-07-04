//! Curated model catalogue (§3.1).
//!
//! A static, hand-curated list. Users pick a model; [`crate::inference::recommend`] steers
//! them to one their hardware can run. Stable `id`s are load-bearing — they key downloads,
//! event names and settings, so **never rename an `id`**.
//!
//! Coordinates (HF repo/file, byte sizes, `kv_bytes_per_token`, RAM/VRAM) are the real values
//! from Ragtag's `inference/model_registry.rs` (2026-07). All GGUFs resolve via HF
//! `resolve/main`, so `sha256`/`download_url` are `None`. The tier is Apache-2.0 only (Qwen)
//! for a clean commercial licence story; Ragtag's Llama alternates are omitted here.

use serde::Serialize;

/// Role a model plays in the stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Chat,
    Embedding,
    Rerank,
}

/// Rough capability bucket, used to offer one candidate per class when recommending.
/// Capability order: `Small < Mid < Large < Moe < XLarge` (Moe sits above dense Large —
/// faster at similar capability — but below XLarge).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SizeClass {
    Small,
    Mid,
    Large,
    Moe,
    XLarge,
}

/// One entry in the catalogue.
#[derive(Debug, Clone, Serialize)]
pub struct ModelEntry {
    /// Stable identifier — never renamed. Key for downloads, events, settings.
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub kind: ModelKind,
    pub hugging_face_repo: &'static str,
    pub hugging_face_file: &'static str,
    /// Download size in bytes, shown before download (equals `disk_footprint_bytes`).
    pub approximate_size_bytes: u64,
    /// Trained context length in tokens.
    pub context_length: u32,
    pub licence: &'static str,
    pub size_class: SizeClass,
    /// Groups quant variants of the same base model.
    pub family: &'static str,
    pub quant_label: &'static str,
    /// Exactly one entry per `family` is the default quant.
    pub is_default_quant: bool,
    /// KV-cache cost per token — drives dynamic context sizing (§2.5).
    pub kv_bytes_per_token: u64,
    /// Human display, e.g. "4B".
    pub parameters: &'static str,
    /// Minimum RAM to load at all.
    pub min_ram_bytes: u64,
    /// Comfort threshold.
    pub recommended_ram_bytes: u64,
    /// VRAM at which GPU offload helps (0 = none).
    pub recommended_vram_bytes: u64,
    pub disk_footprint_bytes: u64,
    /// Integrity pin, when custom-hosted. `None` → skip hash check.
    pub sha256: Option<&'static str>,
    /// Override download URL, else HF `resolve/main`.
    pub download_url: Option<&'static str>,
}

const GIB: u64 = 1024 * 1024 * 1024;

/// The default/fallback chat model — Qwen3.5 4B, default quant Q5_K_M. The recommender
/// upgrades to the most capable size class that fits the machine.
pub const DEFAULT_CHAT_MODEL_ID: &str = "qwen3.5-4b-q5_k_m";

/// The curated catalogue. Chat sizes span Small→Moe; one embedding model for RAG (Phase 4).
pub const CATALOGUE: &[ModelEntry] = &[
    // ── Qwen3.5 4B — the default (Small) ──────────────────────────────────────
    ModelEntry {
        id: "qwen3.5-4b-q5_k_m",
        display_name: "Qwen3.5 4B",
        description: "Default. Best balance of quality and speed on a typical laptop.",
        kind: ModelKind::Chat,
        hugging_face_repo: "bartowski/Qwen_Qwen3.5-4B-GGUF",
        hugging_face_file: "Qwen_Qwen3.5-4B-Q5_K_M.gguf",
        approximate_size_bytes: 3_443_763_168,
        context_length: 262_144,
        licence: "Apache 2.0",
        size_class: SizeClass::Small,
        family: "qwen3.5-4b",
        quant_label: "Q5_K_M",
        is_default_quant: true,
        kv_bytes_per_token: 135_168,
        parameters: "4B",
        min_ram_bytes: 6 * GIB,
        recommended_ram_bytes: 8 * GIB,
        recommended_vram_bytes: 6 * GIB,
        disk_footprint_bytes: 3_443_763_168,
        sha256: None,
        download_url: None,
    },
    ModelEntry {
        id: "qwen3.5-4b-q6_k",
        display_name: "Qwen3.5 4B (higher quality)",
        description: "Q6_K quant of the 4B — slightly better quality, a little larger.",
        kind: ModelKind::Chat,
        hugging_face_repo: "bartowski/Qwen_Qwen3.5-4B-GGUF",
        hugging_face_file: "Qwen_Qwen3.5-4B-Q6_K.gguf",
        approximate_size_bytes: 3_805_358_048,
        context_length: 262_144,
        licence: "Apache 2.0",
        size_class: SizeClass::Small,
        family: "qwen3.5-4b",
        quant_label: "Q6_K",
        is_default_quant: false,
        kv_bytes_per_token: 135_168,
        parameters: "4B",
        min_ram_bytes: 6 * GIB,
        recommended_ram_bytes: 8 * GIB,
        recommended_vram_bytes: 6 * GIB,
        disk_footprint_bytes: 3_805_358_048,
        sha256: None,
        download_url: None,
    },
    // ── Qwen3.5 9B (Mid) ──────────────────────────────────────────────────────
    ModelEntry {
        id: "qwen3.5-9b-q4_k_m",
        display_name: "Qwen3.5 9B",
        description: "More capable — for machines with 16 GB+ RAM.",
        kind: ModelKind::Chat,
        hugging_face_repo: "bartowski/Qwen_Qwen3.5-9B-GGUF",
        hugging_face_file: "Qwen_Qwen3.5-9B-Q4_K_M.gguf",
        approximate_size_bytes: 6_169_341_984,
        context_length: 262_144,
        licence: "Apache 2.0",
        size_class: SizeClass::Mid,
        family: "qwen3.5-9b",
        quant_label: "Q4_K_M",
        is_default_quant: true,
        kv_bytes_per_token: 135_168,
        parameters: "9B",
        min_ram_bytes: 8 * GIB,
        recommended_ram_bytes: 16 * GIB,
        recommended_vram_bytes: 8 * GIB,
        disk_footprint_bytes: 6_169_341_984,
        sha256: None,
        download_url: None,
    },
    // ── Qwen3.6 27B (Large) ───────────────────────────────────────────────────
    ModelEntry {
        id: "qwen3.6-27b-q4_k_m",
        display_name: "Qwen3.6 27B",
        description: "High quality — needs a workstation (32 GB+ RAM). Slower.",
        kind: ModelKind::Chat,
        hugging_face_repo: "bartowski/Qwen_Qwen3.6-27B-GGUF",
        hugging_face_file: "Qwen_Qwen3.6-27B-Q4_K_M.gguf",
        approximate_size_bytes: 17_984_872_960,
        context_length: 262_144,
        licence: "Apache 2.0",
        size_class: SizeClass::Large,
        family: "qwen3.6-27b",
        quant_label: "Q4_K_M",
        is_default_quant: true,
        kv_bytes_per_token: 266_240,
        parameters: "27B",
        min_ram_bytes: 24 * GIB,
        recommended_ram_bytes: 32 * GIB,
        recommended_vram_bytes: 20 * GIB,
        disk_footprint_bytes: 17_984_872_960,
        sha256: None,
        download_url: None,
    },
    // ── Qwen3.6 35B-A3B — Mixture-of-Experts (Moe): 35B total / 3B active ──────
    ModelEntry {
        id: "qwen3.6-35b-a3b-q4_k_m",
        display_name: "Qwen3.6 35B-A3B (MoE)",
        description: "Mixture-of-Experts — top quality, much faster than dense 27B if it fits.",
        kind: ModelKind::Chat,
        hugging_face_repo: "bartowski/Qwen_Qwen3.6-35B-A3B-GGUF",
        hugging_face_file: "Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf",
        approximate_size_bytes: 22_285_080_192,
        context_length: 262_144,
        licence: "Apache 2.0",
        size_class: SizeClass::Moe,
        family: "qwen3.6-35b-a3b",
        quant_label: "Q4_K_M",
        is_default_quant: true,
        kv_bytes_per_token: 83_968,
        parameters: "35B (3B active)",
        min_ram_bytes: 26 * GIB,
        recommended_ram_bytes: 32 * GIB,
        recommended_vram_bytes: 24 * GIB,
        disk_footprint_bytes: 22_285_080_192,
        sha256: None,
        download_url: None,
    },
    // ── Embedding (Phase 4 RAG) — 768-dim; vector table width depends on this ──
    ModelEntry {
        id: "nomic-embed-text-v1.5-q8",
        display_name: "Nomic Embed Text v1.5",
        description: "768-dim embedding model for semantic RAG over unstructured docs.",
        kind: ModelKind::Embedding,
        hugging_face_repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
        hugging_face_file: "nomic-embed-text-v1.5.Q8_0.gguf",
        approximate_size_bytes: 146_500_000,
        context_length: 8_192,
        licence: "Apache 2.0",
        size_class: SizeClass::Small,
        family: "nomic-embed-text-v1.5",
        quant_label: "Q8_0",
        is_default_quant: true,
        kv_bytes_per_token: 0,
        parameters: "137M",
        min_ram_bytes: 2 * GIB,
        recommended_ram_bytes: 4 * GIB,
        recommended_vram_bytes: 0,
        disk_footprint_bytes: 146_500_000,
        sha256: None,
        download_url: None,
    },
];

/// Look up a catalogue entry by its stable id.
pub fn find(id: &str) -> Option<&'static ModelEntry> {
    CATALOGUE.iter().find(|m| m.id == id)
}

/// The default chat model entry.
pub fn default_chat_model() -> &'static ModelEntry {
    find(DEFAULT_CHAT_MODEL_ID).expect("default chat model must exist in the catalogue")
}

/// All entries of a given kind.
pub fn of_kind(kind: ModelKind) -> impl Iterator<Item = &'static ModelEntry> {
    CATALOGUE.iter().filter(move |m| m.kind == kind)
}
