//! Hardware detection (§3.2).
//!
//! Feeds [`crate::inference::recommend`]. All GPU probes are best-effort and degrade to
//! `None` — the recommendation still works off system RAM when VRAM is unknown.
//!
//! TODO(phase0): implement [`detect`] with `sysinfo` (total/available RAM, CPU, free disk),
//! `nvml-wrapper` (NVIDIA VRAM), and `ash`/Vulkan (AMD/generic VRAM). On Apple Silicon,
//! unified memory means the VRAM budget = total RAM.

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Detected machine capabilities.
#[derive(Debug, Clone, Serialize)]
pub struct HardwareInfo {
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    /// Free space on the volume that holds downloaded models.
    pub free_disk_bytes: u64,
    pub gpu: GpuInfo,
}

#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub kind: GpuKind,
    /// Best-effort VRAM budget in bytes. `None` when it couldn't be read.
    pub vram_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuKind {
    /// Apple Silicon unified memory → VRAM budget equals total RAM.
    AppleUnified,
    Nvidia,
    Vulkan,
    None,
}

/// Detect this machine's capabilities.
pub fn detect() -> AppResult<HardwareInfo> {
    Err(AppError::inference(
        "hardware detection not yet implemented (needs sysinfo/nvml-wrapper/ash)",
    ))
}
