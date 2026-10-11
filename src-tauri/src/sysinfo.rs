/*
 * 系统状态读数（FUTURE.md 功能 14 第 10 条：K5 首页要的那三个数据源）。
 *
 * 为什么单独一个文件：这三样（盘的容量 / 电池 / 磁盘类型）都是**只读的系统事实**，
 * 和 toolbox.rs 里那堆「装东西」的命令不是一类事，也和 files.rs 的文件操作没关系。
 *
 * 全部走 Win32 直读（GetDiskFreeSpaceEx / GetSystemPowerStatus），不调 PowerShell：
 * 这两个调用都是微秒级，而 PowerShell 起一次进程要几百毫秒 —— 首页一挂载就要显示的数，
 * 让用户白等半秒不值得。非 Windows 平台返回空 / 无电池，界面写「—」。
 *
 * 唯一的例外：**一条盘都读不到时**退到 WMI 再问一遍（见 windows::wmi_drives）。这不是奢侈，
 * 是 0.1.61 真机教训 —— 侧栏那颗「存储空间」一直写「容量读取待接入」（也就是这条命令
 * 一次都没给出盘）；宁可慢一次，也不能让那张卡一直空着。卡在哪一步，看日志里的 `sysinfo:` 行。
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

pub(crate) fn drives_now() -> Vec<DriveSpace> {
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
    /// 为几个整数拉一整个 feature 不值；这些值从 Win95 起就没变过，照抄文档）。
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;

    /// 盘的种类给界面看的三档。**除网络盘 / 光驱外的类型（RAM 盘、认不出类型的卷）也照收**：
    /// 只放行「固定盘 / 移动盘」的话，一旦某台机器的系统盘被认成别的类型，整张卡就会空着。
    /// 宁可多列一块盘，也不要空着；真不确定时看日志里每个盘符的 `type=`。
    fn kind_name(code: u32) -> &'static str {
        match code {
            DRIVE_FIXED => "fixed",
            DRIVE_REMOVABLE => "removable",
            _ => "other",
        }
    }

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
            if kind_code == DRIVE_REMOTE || kind_code == DRIVE_CDROM {
                // 网络映射盘 / 光驱**故意不列**：首页那块「存储空间」是给能装游戏盘的，
                // 而断开映射的网络盘会把 GetDiskFreeSpaceEx 拖住好几秒（首页要秒开）。
                // 留一行日志：真机上报「容量读不到」时能一眼看出是不是被这里跳过的。
                crate::logutil::write_line(&format!("sysinfo: skip {mount} type={kind_code}"));
                continue;
            }
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
                kind: kind_name(kind_code).to_string(),
            });
        }
        // 内置盘排最前：界面取「第一块盘」当主盘（侧栏那颗卡、首页那一格）。
        out.sort_by_key(|row| match row.kind.as_str() {
            "fixed" => 0,
            "removable" => 1,
            _ => 2,
        });
        if out.is_empty() {
            // 一块盘都没读到 —— 系统盘不可能凭空消失，所以这不是「这台机器没盘」，
            // 是我们这条路径在它上面不灵。宁可慢一次（起一个 PowerShell），
            // 也不要给用户一张一直写「容量读取待接入」的卡。
            crate::logutil::write_line("sysinfo: no drives via Win32; falling back to WMI");
            out = wmi_drives();
            crate::logutil::write_line(&format!("sysinfo: WMI returned {} drives", out.len()));
        }
        out
    }

    /// 最后一道退路：让 WMI 报一遍盘。**故意用 PowerShell**：它走的是完全不同的取数链路
    /// （WMI 服务 + `Win32_LogicalDisk`），上面那条 Win32 路在这一台上不灵时它往往还灵。
    /// 只在一条盘都没读到的时候才走这里，所以正常开机不会多花这半秒。
    fn wmi_drives() -> Vec<DriveSpace> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const SCRIPT: &str = "$ErrorActionPreference='SilentlyContinue'; \
             Get-CimInstance -ClassName Win32_LogicalDisk | ForEach-Object { \
             \"$($_.DeviceID)|$($_.DriveType)|$($_.Size)|$($_.FreeSpace)\" }";
        let Ok(output) = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        else {
            crate::logutil::write_line("sysinfo: WMI fallback: powershell didn't start");
            return Vec::new();
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let mut rows = Vec::new();
        for line in text.lines() {
            let mut parts = line.trim().split('|');
            let (Some(mount), Some(drive_type), Some(size), Some(free)) = (
                parts.next(),
                parts.next(),
                parts.next(),
                parts.next(),
            ) else {
                continue;
            };
            // 盘符必须像 `C:`；Size 为空（空读卡器、光驱）或 0 的一律不要。
            let Ok(total_bytes) = size.trim().parse::<u64>() else {
                continue;
            };
            if total_bytes == 0 || !mount.trim().ends_with(':') {
                continue;
            }
            let kind = match drive_type.trim() {
                "2" => "removable",
                "3" => "fixed",
                _ => "other",
            };
            rows.push(DriveSpace {
                mount: mount.trim().to_string(),
                // WMI 有 VolumeName，但那要多取一列、还可能带编码问题；
                // 卷标只是卡片上的一行小字，空着比编一个强。
                label: String::new(),
                total_bytes,
                free_bytes: free.trim().parse::<u64>().unwrap_or(0),
                kind: kind.to_string(),
            });
        }
        rows.sort_by_key(|row| match row.kind.as_str() {
            "fixed" => 0,
            "removable" => 1,
            _ => 2,
        });
        rows
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
