//! TDP 的数据结构（两个程序共用一份定义）。
//!
//! 真正的读写 MSR 在启动器里（它提权、装了 WinRing0）；前端通过 [`crate::ipc`]
//! 问启动器要，拿到的就是这里的 `TdpInfo` 形状。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TdpInfo {
    pub vendor: String,
    pub cpu_name: String,
    pub min_w: u32,
    pub max_w: u32,
    pub watts: Option<u32>,
    pub presets: Vec<u32>,
    pub supported: bool,
    pub backend: String,
    pub message: String,
}

/// TDP 驱动（WinRing0）是否就绪。前端只读它来决定「显示滑条还是显示安装引导」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TdpDriverStatus {
    pub ready: bool,
    pub elevated: bool,
    /// 文件/服务已在盘上 —— 可能只差重启后启动。
    pub installed: bool,
    pub message: String,
}
