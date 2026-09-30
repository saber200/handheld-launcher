//! 前端的 TDP 客户端：把请求转给启动器的本地 IPC（协议在 `fh_core::ipc`）。
//!
//! 前端**不提权**（每次开机弹 UAC 的托盘软件没法用），真实读写 MSR 永远由提权的启动器
//! 完成。启动器没运行/TDP 驱动没装时，这里返回错误、界面把 TDP 区显示为不可用，其余
//! 功能照常（FRONTEND.md §4）。命令名与启动器保持一致，从 0.1.45 搬来的界面几乎不用改。

use fh_core::ipc;
use fh_core::tdp::{TdpDriverStatus, TdpInfo};

#[tauri::command]
pub async fn tdp_status() -> Result<TdpInfo, String> {
    let value = crate::off_main(|| ipc::request(ipc::CMD_TDP_STATUS, None)).await??;
    serde_json::from_value(value).map_err(|err| format!("TDP 响应无法解析：{err}"))
}

#[tauri::command]
pub async fn set_tdp(watts: u32) -> Result<TdpInfo, String> {
    let value = crate::off_main(move || ipc::request(ipc::CMD_SET_TDP, Some(watts))).await??;
    serde_json::from_value(value).map_err(|err| format!("TDP 响应无法解析：{err}"))
}

/// 只读：驱动是否就绪决定界面显示滑条还是显示引导文案。
///
/// **安装**驱动不在这里 —— 那要提权，入口在启动器的工具箱（前端不替任何人装内核驱动，
/// 这是刻意留的边界）。
#[tauri::command]
pub async fn toolbox_tdp_driver_status() -> Result<TdpDriverStatus, String> {
    let value = crate::off_main(|| ipc::request(ipc::CMD_TDP_DRIVER_STATUS, None)).await??;
    serde_json::from_value(value).map_err(|err| format!("驱动状态无法解析：{err}"))
}
