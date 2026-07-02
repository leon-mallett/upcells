//! Hardware detection (§3.2).
//!
//! Feeds [`crate::inference::recommend`]. All GPU probes are best-effort and degrade to
//! `None` — the recommendation still works off system RAM when VRAM is unknown.
//!
//! Implemented with `sysinfo` (RAM/CPU/free-disk). Apple Silicon reports unified memory, so
//! the VRAM budget equals total RAM. Discrete-GPU VRAM (NVIDIA via `nvml-wrapper`, AMD/
//! generic via `ash`/Vulkan) is deferred to the Windows/Linux accelerator work — those paths
//! return `None` for now.

use std::path::Path;

use serde::Serialize;
use sysinfo::{Disks, System};

use crate::error::AppResult;

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

/// Detect this machine's capabilities. `models_dir` selects which volume's free space to
/// report (the disk that will hold downloaded models).
pub fn detect(models_dir: &Path) -> AppResult<HardwareInfo> {
    let sys = System::new_all();

    let total_ram_bytes = sys.total_memory();
    let available_ram_bytes = sys.available_memory();

    // Prefer physical cores; fall back to logical if unavailable.
    let cpu_cores = sys.physical_core_count().unwrap_or_else(|| sys.cpus().len());
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let free_disk_bytes = free_disk_for(models_dir);
    let gpu = detect_gpu(total_ram_bytes);

    Ok(HardwareInfo {
        total_ram_bytes,
        available_ram_bytes,
        cpu_brand,
        cpu_cores,
        free_disk_bytes,
        gpu,
    })
}

/// Free bytes on the volume backing `path`: the disk whose mount point is the longest
/// prefix of `path` (so a dedicated data volume wins over `/`).
fn free_disk_for(path: &Path) -> u64 {
    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point();
        if path.starts_with(mount) {
            let specificity = mount.as_os_str().len();
            if best.map_or(true, |(len, _)| specificity > len) {
                best = Some((specificity, disk.available_space()));
            }
        }
    }
    // Fall back to the most-free disk if nothing matched (e.g. path not yet created).
    best.map(|(_, free)| free).unwrap_or_else(|| {
        disks
            .list()
            .iter()
            .map(|d| d.available_space())
            .max()
            .unwrap_or(0)
    })
}

/// Best-effort GPU classification + VRAM budget.
fn detect_gpu(total_ram_bytes: u64) -> GpuInfo {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        // Apple Silicon: the GPU shares system RAM (unified memory).
        GpuInfo {
            kind: GpuKind::AppleUnified,
            vram_bytes: Some(total_ram_bytes),
        }
    } else {
        // TODO(step 2c): NVIDIA VRAM via `nvml-wrapper`, AMD/generic via `ash`/Vulkan.
        GpuInfo {
            kind: GpuKind::None,
            vram_bytes: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_reports_plausible_values() {
        let hw = detect(Path::new("/")).expect("detection should succeed");
        // Visible with `cargo test -- --nocapture`; useful when debugging detection.
        eprintln!(
            "[hardware] {} ({} cores), {:.1} GiB RAM ({:.1} free), {:.1} GiB free disk, gpu {:?}",
            hw.cpu_brand,
            hw.cpu_cores,
            hw.total_ram_bytes as f64 / 1e9,
            hw.available_ram_bytes as f64 / 1e9,
            hw.free_disk_bytes as f64 / 1e9,
            hw.gpu.kind,
        );
        assert!(hw.total_ram_bytes > 0, "total RAM should be non-zero");
        assert!(hw.available_ram_bytes > 0, "available RAM should be non-zero");
        assert!(hw.cpu_cores > 0, "should report at least one core");
        assert!(!hw.cpu_brand.is_empty(), "CPU brand should be populated");
        assert!(hw.free_disk_bytes > 0, "root volume should report free space");
    }
}
