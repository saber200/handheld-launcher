use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};

use crate::i18n::pick;

const MIN_W: u32 = 5;
const MAX_W: u32 = 40;
const PRESETS: [u32; 6] = [5, 10, 15, 25, 35, 40];
static LAST_WATTS: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Clone, Serialize)]
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

#[tauri::command]
pub fn tdp_status() -> TdpInfo {
    #[cfg(windows)]
    {
        return windows::status();
    }
    #[cfg(not(windows))]
    {
        TdpInfo {
            vendor: "unknown".into(),
            cpu_name: String::new(),
            min_w: MIN_W,
            max_w: MAX_W,
            watts: stored_watts(),
            presets: PRESETS.to_vec(),
            supported: false,
            backend: "none".into(),
            message: pick(
                "TDP 只能在 Windows 掌机上调节。",
                "TDP can only be adjusted on Windows handhelds.",
            ),
        }
    }
}

#[tauri::command]
pub fn set_tdp(watts: u32) -> Result<TdpInfo, String> {
    let watts = watts.clamp(MIN_W, MAX_W);
    #[cfg(windows)]
    {
        return windows::set_watts(watts).map_err(|err| {
            crate::logutil::write_line(&format!("set_tdp({watts}) failed: {err}"));
            err
        });
    }
    #[cfg(not(windows))]
    {
        let _ = watts;
        Err(pick(
            "TDP 只能在 Windows 掌机上调节。",
            "TDP can only be adjusted on Windows handhelds.",
        ))
    }
}

fn stored_watts() -> Option<u32> {
    let value = LAST_WATTS.load(Ordering::Relaxed);
    (value >= MIN_W && value <= MAX_W).then_some(value)
}

/// Whether the WinRing0 device can be opened (TDP backend ready).
pub fn winring0_ready() -> bool {
    #[cfg(windows)]
    {
        return windows::driver_ready();
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn remember_watts(watts: u32) {
    LAST_WATTS.store(watts, Ordering::Relaxed);
    #[cfg(windows)]
    windows::save_preferred(watts);
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;

    const MSR_PKG_POWER_LIMIT: u32 = 0x610;
    const OLS_TYPE: u32 = 40_000;
    const IOCTL_OLS_READ_MSR: u32 = ctl_code(OLS_TYPE, 0x821, 0, 0);
    const IOCTL_OLS_WRITE_MSR: u32 = ctl_code(OLS_TYPE, 0x822, 0, 0);

    const DEVICE_NAMES: [&str; 2] = ["\\\\.\\WinRing0_1_2_0", "\\\\.\\WinRing0x64"];

    pub fn status() -> TdpInfo {
        load_preferred();
        let cpu_name = cpu_name();
        let vendor = vendor_from_name(&cpu_name);
        let driver = open_driver();
        let mut watts = stored_watts();
        let mut backend = "none".to_string();
        let mut supported = false;
        let message;

        if vendor != "intel" {
            message = pick(
                "当前先做 Intel 功耗控制；这台机器不是 Intel，稍后再接 AMD。",
                "Intel power limits first; this CPU isn't Intel, AMD comes later.",
            );
            return TdpInfo {
                vendor: vendor.into(),
                cpu_name,
                min_w: MIN_W,
                max_w: MAX_W,
                watts,
                presets: PRESETS.to_vec(),
                supported: false,
                backend,
                message,
            };
        }

        if let Some(handle) = driver {
            backend = "intel-msr".into();
            supported = true;
            if let Ok(current) = read_pl1(handle) {
                watts = Some(current.clamp(MIN_W, MAX_W));
                remember_watts(current.clamp(MIN_W, MAX_W));
            }
            unsafe {
                CloseHandle(handle);
            }
            message = pick(
                "可用 Intel MSR 调节 TDP（5–40W）。",
                "Intel MSR TDP control is available (5–40W).",
            );
        } else {
            message = pick(
                "检测到 Intel，但读不到 WinRing0。请在工具箱安装 TDP 驱动，并以管理员运行。",
                "Intel detected, but WinRing0 isn't available. Install the TDP driver from the toolbox, and run as admin.",
            );
        }

        TdpInfo {
            vendor: vendor.into(),
            cpu_name,
            min_w: MIN_W,
            max_w: MAX_W,
            watts,
            presets: PRESETS.to_vec(),
            supported,
            backend,
            message,
        }
    }

    pub fn set_watts(watts: u32) -> Result<TdpInfo, String> {
        let cpu_name = cpu_name();
        let vendor = vendor_from_name(&cpu_name);
        if vendor != "intel" {
            return Err(pick(
                "当前只支持 Intel 功耗上限。",
                "Only Intel power limits are supported right now.",
            ));
        }

        let Some(handle) = open_driver() else {
            return Err(pick(
                "打不开 WinRing0。请在工具箱安装 TDP 驱动，并以管理员运行 FantasyHub。",
                "Couldn't open WinRing0. Install the TDP driver from the toolbox, and run FantasyHub as admin.",
            ));
        };

        let result = write_pl(handle, watts, watts);
        unsafe {
            CloseHandle(handle);
        }
        result?;
        remember_watts(watts);

        let mut info = status();
        info.watts = Some(watts);
        info.message = pick(
            &format!("已将 TDP 设为 {watts}W。"),
            &format!("TDP set to {watts}W."),
        );
        Ok(info)
    }

    fn write_pl(handle: HANDLE, pl1: u32, pl2: u32) -> Result<(), String> {
        let value = encode_pkg_power_limit(pl1, pl2);
        write_msr(handle, MSR_PKG_POWER_LIMIT, value).map_err(|detail| {
            pick(
                &format!("写入功耗上限失败：{detail}"),
                &format!("Failed to write power limit: {detail}"),
            )
        })
    }

    fn read_pl1(handle: HANDLE) -> Result<u32, String> {
        let value = read_msr(handle, MSR_PKG_POWER_LIMIT)?;
        Ok(decode_pl1(value))
    }

    /// MSR 0x610 with enable+clamp and a handheld-friendly time window (UXTU-compatible).
    fn encode_pkg_power_limit(pl1_w: u32, pl2_w: u32) -> u64 {
        let pl1 = (pl1_w.saturating_mul(8) & 0x7FFF) as u64;
        let pl2 = (pl2_w.saturating_mul(8) & 0x7FFF) as u64;
        let low = 0x00DD_8000u64 | pl1;
        let high = 0x0043_8000u64 | pl2;
        (high << 32) | low
    }

    fn decode_pl1(value: u64) -> u32 {
        let units = (value & 0x7FFF) as u32;
        units / 8
    }

    fn read_msr(handle: HANDLE, register: u32) -> Result<u64, String> {
        let mut output = 0u64;
        let mut returned = 0u32;
        let ok = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_OLS_READ_MSR,
                &register as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
                &mut output as *mut u64 as *mut _,
                std::mem::size_of::<u64>() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || returned < 8 {
            return Err(pick("读取 MSR 失败", "MSR read failed"));
        }
        Ok(output)
    }

    // OpenLibSys / WinRing0 expects packed { u32 register, u64 value }.
    #[repr(C, packed)]
    struct WriteMsrInput {
        register: u32,
        value: u64,
    }

    fn write_msr(handle: HANDLE, register: u32, value: u64) -> Result<(), String> {
        let input = WriteMsrInput { register, value };
        let mut returned = 0u32;
        let ok = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_OLS_WRITE_MSR,
                &input as *const WriteMsrInput as *const _,
                12,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(pick("写入 MSR 失败", "MSR write failed"));
        }
        Ok(())
    }

    fn open_driver() -> Option<HANDLE> {
        for name in DEVICE_NAMES {
            let wide = to_wide(name);
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Some(handle);
            }
        }
        None
    }

    pub fn driver_ready() -> bool {
        let Some(handle) = open_driver() else {
            return false;
        };
        unsafe {
            CloseHandle(handle);
        }
        true
    }

    fn cpu_name() -> String {
        let key = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
            .open_subkey(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            .ok();
        key.and_then(|k| k.get_value::<String, _>("ProcessorNameString").ok())
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    fn vendor_from_name(name: &str) -> &'static str {
        let lower = name.to_ascii_lowercase();
        if lower.contains("intel") || lower.contains("arc g3") {
            "intel"
        } else if lower.contains("amd") || lower.contains("ryzen") {
            "amd"
        } else {
            "unknown"
        }
    }

    fn state_path() -> Option<PathBuf> {
        let appdata = std::env::var_os("APPDATA")?;
        Some(PathBuf::from(appdata).join("handheld-launcher").join("tdp.txt"))
    }

    pub fn save_preferred(watts: u32) {
        let Some(path) = state_path() else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, watts.to_string());
    }

    fn load_preferred() {
        if stored_watts().is_some() {
            return;
        }
        let Some(path) = state_path() else {
            return;
        };
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(watts) = text.trim().parse::<u32>() {
                if (MIN_W..=MAX_W).contains(&watts) {
                    LAST_WATTS.store(watts, Ordering::Relaxed);
                }
            }
        }
    }

    const fn ctl_code(device_type: u32, function: u32, method: u32, access: u32) -> u32 {
        (device_type << 16) | (access << 14) | (function << 2) | method
    }

    fn to_wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
}
