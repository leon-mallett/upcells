//! Curated model catalogue (§3.1).
//!
//! A static, hand-curated list. Users pick a model; [`crate::inference::recommend`] steers
//! them to one their hardware can run. Stable `id`s are load-bearing — they key downloads,
//! event names and settings, so **never rename an `id`**.
//!
//! TODO(phase0): the Hugging Face repo/file names, byte sizes, `kv_bytes_per_token`, and
//! `sha256` pins below are PLACEHOLDERS. Confirm exact values against Ragtag's real
//! `inference/model_registry.rs` before wiring the downloader.

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
    /// Download size in bytes, shown before download.
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

const GB: u64 = 1024 * 1024 * 1024;

/// The default chat model — proven in Ragtag. See [`crate::inference::recommend`] for how a
/// more capable model is offered when the machine can handle it.
pub const DEFAULT_CHAT_MODEL_ID: &str = "qwen3.5-4b-q4_k_m";

/// The curated catalogue. Keep it small: a few chat sizes + one embedding model.
pub const CATALOGUE: &[ModelEntry] = &[
    // ── Chat: low-end fallback ────────────────────────────────────────────────
    ModelEntry {
        id: "qwen3.5-1.7b-q4_k_m",
        display_name: "Qwen 3.5 1.7B",
        description: "Smallest chat model — for low-spec machines. Faster, less capable.",
        kind: ModelKind::Chat,
        hugging_face_repo: "Qwen/Qwen3.5-1.7B-GGUF",
        hugging_face_file: "Qwen3.5-1.7B-Q4_K_M.gguf",
        approximate_size_bytes: 1_100 * 1024 * 1024,
        context_length: 32_768,
        licence: "Apache-2.0",
        size_class: SizeClass::Small,
        family: "qwen3.5-1.7b",
        quant_label: "Q4_K_M",
        is_default_quant: true,
        kv_bytes_per_token: 112 * 1024,
        parameters: "1.7B",
        min_ram_bytes: 3 * GB,
        recommended_ram_bytes: 4 * GB,
        recommended_vram_bytes: 0,
        disk_footprint_bytes: 1_100 * 1024 * 1024,
        sha256: None,
        download_url: None,
    },
    // ── Chat: default (Qwen 3.5 4B), two quant variants in one family ─────────
    ModelEntry {
        id: "qwen3.5-4b-q4_k_m",
        display_name: "Qwen 3.5 4B",
        description: "Default. Best balance of quality and speed on a typical laptop.",
        kind: ModelKind::Chat,
        hugging_face_repo: "Qwen/Qwen3.5-4B-GGUF",
        hugging_face_file: "Qwen3.5-4B-Q4_K_M.gguf",
        approximate_size_bytes: 2_500 * 1024 * 1024,
        context_length: 32_768,
        licence: "Apache-2.0",
        size_class: SizeClass::Mid,
        family: "qwen3.5-4b",
        quant_label: "Q4_K_M",
        is_default_quant: true,
        kv_bytes_per_token: 256 * 1024,
        parameters: "4B",
        min_ram_bytes: 6 * GB,
        recommended_ram_bytes: 8 * GB,
        recommended_vram_bytes: 0,
        disk_footprint_bytes: 2_500 * 1024 * 1024,
        sha256: None,
        download_url: None,
    },
    ModelEntry {
        id: "qwen3.5-4b-q5_k_m",
        display_name: "Qwen 3.5 4B (higher quality)",
        description: "Q5 quant of the 4B — slightly better quality, a little larger/slower.",
        kind: ModelKind::Chat,
        hugging_face_repo: "Qwen/Qwen3.5-4B-GGUF",
        hugging_face_file: "Qwen3.5-4B-Q5_K_M.gguf",
        approximate_size_bytes: 2_900 * 1024 * 1024,
        context_length: 32_768,
        licence: "Apache-2.0",
        size_class: SizeClass::Mid,
        family: "qwen3.5-4b",
        quant_label: "Q5_K_M",
        is_default_quant: false,
        kv_bytes_per_token: 256 * 1024,
        parameters: "4B",
        min_ram_bytes: 6 * GB,
        recommended_ram_bytes: 9 * GB,
        recommended_vram_bytes: 0,
        disk_footprint_bytes: 2_900 * 1024 * 1024,
        sha256: None,
        download_url: None,
    },
    // ── Chat: for capable machines ────────────────────────────────────────────
    ModelEntry {
        id: "qwen3.5-8b-q4_k_m",
        display_name: "Qwen 3.5 8B",
        description: "More capable — for machines with plenty of RAM/VRAM. Slower.",
        kind: ModelKind::Chat,
        hugging_face_repo: "Qwen/Qwen3.5-8B-GGUF",
        hugging_face_file: "Qwen3.5-8B-Q4_K_M.gguf",
        approximate_size_bytes: 4_900 * 1024 * 1024,
        context_length: 32_768,
        licence: "Apache-2.0",
        size_class: SizeClass::Large,
        family: "qwen3.5-8b",
        quant_label: "Q4_K_M",
        is_default_quant: true,
        kv_bytes_per_token: 512 * 1024,
        parameters: "8B",
        min_ram_bytes: 10 * GB,
        recommended_ram_bytes: 16 * GB,
        recommended_vram_bytes: 8 * GB,
        disk_footprint_bytes: 4_900 * 1024 * 1024,
        sha256: None,
        download_url: None,
    },
    // ── Embedding (Phase 4 RAG) ───────────────────────────────────────────────
    ModelEntry {
        id: "nomic-embed-text-v1.5-q8_0",
        display_name: "Nomic Embed Text v1.5",
        description: "768-dim embedding model for semantic RAG over unstructured docs.",
        kind: ModelKind::Embedding,
        hugging_face_repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
        hugging_face_file: "nomic-embed-text-v1.5.Q8_0.gguf",
        approximate_size_bytes: 140 * 1024 * 1024,
        context_length: 2_048,
        licence: "Apache-2.0",
        size_class: SizeClass::Small,
        family: "nomic-embed-text-v1.5",
        quant_label: "Q8_0",
        is_default_quant: true,
        kv_bytes_per_token: 0,
        parameters: "137M",
        min_ram_bytes: 1 * GB,
        recommended_ram_bytes: 2 * GB,
        recommended_vram_bytes: 0,
        disk_footprint_bytes: 140 * 1024 * 1024,
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
