//! Hardware → model recommendation (§3.3).
//!
//! Pure logic over [`HardwareInfo`] and the [`CATALOGUE`] — no external deps, fully unit
//! testable. Picks one chat model with an honest tier + rationale rather than something
//! that OOMs. A sales laptop is the target: lead small, be honest about speed.

use serde::Serialize;

use crate::inference::hardware::{GpuKind, GpuInfo, HardwareInfo};
use crate::inference::model_registry::{ModelEntry, ModelKind, CATALOGUE};

/// How comfortably the machine can run the recommended model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// `recommended_ram_bytes` fits the budget.
    Comfortable,
    /// Only `min_ram_bytes` fits — will work, may feel slow.
    Loadable,
    /// Nothing fit cleanly; smallest model with a caveat.
    Fallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    /// A discrete GPU is present but its VRAM couldn't be read.
    Low,
}

#[derive(Debug, Clone, Serialize)]
pub struct Recommendation {
    pub model_id: &'static str,
    pub tier: Tier,
    pub confidence: Confidence,
    pub rationale: String,
}

/// 2 GiB of disk headroom required on top of the model footprint.
const DISK_HEADROOM: u64 = 2 * 1024 * 1024 * 1024;

/// Memory budget: Apple unified RAM | discrete VRAM (if known) | system RAM fallback.
fn memory_budget(hw: &HardwareInfo) -> u64 {
    match hw.gpu.kind {
        GpuKind::AppleUnified => hw.total_ram_bytes,
        GpuKind::Nvidia | GpuKind::Vulkan => hw.gpu.vram_bytes.unwrap_or(hw.total_ram_bytes),
        GpuKind::None => hw.total_ram_bytes,
    }
}

fn confidence(gpu: &GpuInfo) -> Confidence {
    match gpu.kind {
        GpuKind::Nvidia | GpuKind::Vulkan if gpu.vram_bytes.is_none() => Confidence::Low,
        _ => Confidence::High,
    }
}

/// Default-quant chat models, largest-first by comfort threshold.
fn chat_candidates() -> Vec<&'static ModelEntry> {
    let mut v: Vec<&ModelEntry> = CATALOGUE
        .iter()
        .filter(|m| m.kind == ModelKind::Chat && m.is_default_quant)
        .collect();
    v.sort_by(|a, b| b.recommended_ram_bytes.cmp(&a.recommended_ram_bytes));
    v
}

fn disk_fits(m: &ModelEntry, hw: &HardwareInfo) -> bool {
    m.disk_footprint_bytes.saturating_add(DISK_HEADROOM) <= hw.free_disk_bytes
}

/// Recommend a chat model for this machine.
pub fn recommend_chat(hw: &HardwareInfo) -> Recommendation {
    let budget = memory_budget(hw);
    let conf = confidence(&hw.gpu);
    let candidates = chat_candidates();

    // Tier 1 — comfortable: largest model whose recommended RAM fits (and disk fits).
    if let Some(m) = candidates
        .iter()
        .find(|m| m.recommended_ram_bytes <= budget && disk_fits(m, hw))
    {
        return Recommendation {
            model_id: m.id,
            tier: Tier::Comfortable,
            confidence: conf,
            rationale: format!("Your computer can comfortably run {}.", m.display_name),
        };
    }

    // Tier 2 — loadable: largest model whose minimum RAM fits (and disk fits).
    if let Some(m) = candidates
        .iter()
        .find(|m| m.min_ram_bytes <= budget && disk_fits(m, hw))
    {
        return Recommendation {
            model_id: m.id,
            tier: Tier::Loadable,
            confidence: conf,
            rationale: format!("{} will work, though replies may feel slower.", m.display_name),
        };
    }

    // Tier 3 — fallback: the smallest model, honest caveat.
    let smallest = candidates
        .last()
        .copied()
        .unwrap_or_else(crate::inference::model_registry::default_chat_model);
    Recommendation {
        model_id: smallest.id,
        tier: Tier::Fallback,
        confidence: conf,
        rationale: format!(
            "{} is the smallest option; this machine is below the comfortable range.",
            smallest.display_name
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::hardware::{GpuInfo, GpuKind, HardwareInfo};

    fn hw(ram_gb: u64, disk_gb: u64, gpu: GpuInfo) -> HardwareInfo {
        HardwareInfo {
            total_ram_bytes: ram_gb * 1024 * 1024 * 1024,
            available_ram_bytes: ram_gb * 1024 * 1024 * 1024,
            cpu_brand: "test".into(),
            cpu_cores: 8,
            free_disk_bytes: disk_gb * 1024 * 1024 * 1024,
            gpu,
        }
    }

    fn no_gpu() -> GpuInfo {
        GpuInfo { kind: GpuKind::None, vram_bytes: None }
    }

    #[test]
    fn high_ram_gets_a_larger_model_comfortably() {
        // 32 GB comfortably fits the 27B (recommended 32 GB).
        let r = recommend_chat(&hw(32, 100, no_gpu()));
        assert_eq!(r.tier, Tier::Comfortable);
        assert_eq!(r.model_id, "qwen3.6-27b-q4_k_m");
    }

    #[test]
    fn typical_laptop_gets_the_default_4b() {
        let r = recommend_chat(&hw(8, 50, no_gpu()));
        assert_eq!(r.tier, Tier::Comfortable);
        assert_eq!(r.model_id, "qwen3.5-4b-q5_k_m");
    }

    #[test]
    fn low_ram_falls_back_to_smallest() {
        // Below the 4B's 6 GB minimum → fallback to the smallest model with a caveat.
        let r = recommend_chat(&hw(4, 50, no_gpu()));
        assert_eq!(r.tier, Tier::Fallback);
        assert_eq!(r.model_id, "qwen3.5-4b-q5_k_m");
    }

    #[test]
    fn tiny_disk_blocks_large_model_despite_ram() {
        // 32 GB RAM but only 10 GB free disk: the 27B (~17 GB) won't fit → step down to 9B.
        let r = recommend_chat(&hw(32, 10, no_gpu()));
        assert_eq!(r.model_id, "qwen3.5-9b-q4_k_m");
    }

    #[test]
    fn discrete_gpu_without_vram_reading_is_low_confidence() {
        let gpu = GpuInfo { kind: GpuKind::Nvidia, vram_bytes: None };
        let r = recommend_chat(&hw(16, 100, gpu));
        assert_eq!(r.confidence, Confidence::Low);
    }
}
