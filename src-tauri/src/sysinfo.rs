/*
 * 系统状态读数（FUTURE.md 功能 14 第 10 条：K5 首页要的那三个数据源）。
 *
 * 为什么单独一个文件：这三样（盘的容量 / 电池 / 磁盘类型）都是**只读的系统事实**，
 * 和 toolbox.rs 里那堆「装东西」的命令不是一类事，也和 files.rs 的文件操作没关系。
 *
 * 全部走 Win32 直读（GetDiskFreeSpaceEx / GetSystemPowerStatus），不调 PowerShell：
 * 这两个调用都是微秒级，而 PowerShell 起一次进程要几百毫秒 —— 首页一挂载就要显示的数，
 * 让用户白等半秒不值得。非 Windows 平台返回空 / 无电池，界面写「—」。
 */
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveSpace {
    /// `C:` 这样的盘符。
    pub mount: String,
    /// 卷标（可能为空 —— 用户没起名字）。
    pub label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    /// `fixed`（内置盘）/ `removable`（U 盘 / SD 卡）/ `other`。
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    /// 这台机器上有没有电池（台式机上为 false，界面就不画续航那一格）。
    pub has_battery: bool,
    pub percent: u8,
    pub charging: bool,
    /// 剩余分钟数。0 = 系统还没算出预估（刚插拔电源时常这样）。
    pub minutes_left: u32,
    /// 能不能读到（macOS = false）。
    pub supported: bool,
}

#[tauri::command]
pub async fn system_storage() -> Vec<DriveSpace> {
    crate::off_main(drives_now).await.unwrap_or_default()
}

#[tauri::command]
pub async fn system_power_status() -> PowerStatus {
    crate::off_main(power_now).await.unwrap_or(PowerStatus {
        has_battery: false,
        percent: 0,
        charging: false,
        minutes_left: 0,
        supported: false,
    })
}

fn drives_now() -> Vec<DriveSpace> {
    #[cfg(windows)]
    {
        return windows::drives();
    }
    #[cfg(not(windows))]
    {
        // macOS 上「盘」的概念和 Windows 不是一回事（/ 挂着所有东西），
        // 硬凑一个出来只会误导，所以如实返回空。
        Vec::new()
    }
}

fn power_now() -> PowerStatus {
    #[cfg(windows)]
    {
        return windows::power();
    }
    #[cfg(not(windows))]
    {
        PowerStatus {
            has_battery: false,
            percent: 0,
            charging: false,
            minutes_left: 0,
            supported: false,
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetVolumeInformationW,
    };
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    /// `GetDriveTypeW` 的返回值（winsys 把它们放在 Win32::System::WindowsProgramming，
    /// 为两个整数拉一整个 feature 不值；这两个值从 Win95 起就没变过，照抄文档）。
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn drives() -> Vec<DriveSpace> {
        let mut out = Vec::new();
        for letter in b'A'..=b'Z' {
            let mount = format!("{}:", letter as char);
            let root = format!("{mount}\\");
            let root_w = wide(&root);
            // SAFETY: root_w 活到调用结束，是个正常的以 NUL 结尾的宽字符串。
            let kind_code = unsafe { GetDriveTypeW(root_w.as_ptr()) };
            let kind = match kind_code {
                DRIVE_FIXED => "fixed",
                DRIVE_REMOVABLE => "removable",
                // 光驱 / 网络盘 / 未知一律跳过：首页那块「存储空间」是给能装游戏盘的，
                // 列一堆网络映射盘只会让人看不懂。
                _ => continue,
            };
            let mut free_bytes = 0u64;
            let mut total_bytes = 0u64;
            // SAFETY: 三个 u64 都是本函数的栈变量；root_w 同上。
            let ok = unsafe {
                GetDiskFreeSpaceExW(
                    root_w.as_ptr(),
                    &mut free_bytes,
                    &mut total_bytes,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 || total_bytes == 0 {
                // 空读卡器 / 没碟的光驱：拿到了盘符但没有卷。
                continue;
            }
            out.push(DriveSpace {
                mount,
                label: volume_label(&root_w),
                total_bytes,
                free_bytes,
                kind: kind.to_string(),
            });
        }
        out
    }

    fn volume_label(root_w: &[u16]) -> String {
        let mut buffer = vec![0u16; 64];
        // SAFETY: buffer 是本函数的栈变量、长度写在参数里；另外三个输出参数传空表示不要。
        let ok = unsafe {
            GetVolumeInformationW(
                root_w.as_ptr(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };
        if ok == 0 {
            return String::new();
        }
        let end = buffer.iter().position(|ch| *ch == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    pub fn power() -> PowerStatus {
        let mut status = SYSTEM_POWER_STATUS::default();
        // SAFETY: status 是本函数的栈变量，API 只往里写。
        let ok = unsafe { GetSystemPowerStatus(&mut status) };
        if ok == 0 {
            return PowerStatus {
                has_battery: false,
                percent: 0,
                charging: false,
                minutes_left: 0,
                supported: false,
            };
        }
        // BatteryFlag = 128 表示「没有系统电池」（台式机）。
        let has_battery = status.BatteryFlag != 128;
        PowerStatus {
            has_battery,
            // 255 = 未知（刚开机 / 电池坏了），这时写 0，界面按「—」处理。
            percent: if status.BatteryLifePercent == 255 {
                0
            } else {
                status.BatteryLifePercent
            },
            // AC 线插着 (1) 就是正在充电 / 已充满。
            charging: status.ACLineStatus == 1,
            minutes_left: if status.BatteryLifeTime == u32::MAX {
                0
            } else {
                status.BatteryLifeTime / 60
            },
            supported: true,
        }
    }
}
