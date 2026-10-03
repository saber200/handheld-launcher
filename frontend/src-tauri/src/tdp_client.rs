//! 普通用户后台仅转发启动器的 TDP 窄接口，不提权、不安装驱动。
//! 同步调用必须由 Widget 的有界工作线程执行。
use fh_core::ipc;
use fh_core::tdp::{TdpDriverStatus, TdpInfo};

pub fn tdp_status() -> Result<TdpInfo, String> {
    let value = ipc::request(ipc::CMD_TDP_STATUS, None)?;
    serde_json::from_value(value).map_err(|err| format!("TDP 响应无法解析：{err}"))
}

pub fn set_tdp(watts: u32) -> Result<TdpInfo, String> {
    let value = ipc::request(ipc::CMD_SET_TDP, Some(watts))?;
    serde_json::from_value(value).map_err(|err| format!("TDP 响应无法解析：{err}"))
}

pub fn toolbox_tdp_driver_status() -> Result<TdpDriverStatus, String> {
    let value = ipc::request(ipc::CMD_TDP_DRIVER_STATUS, None)?;
    serde_json::from_value(value).map_err(|err| format!("驱动状态无法解析：{err}"))
}