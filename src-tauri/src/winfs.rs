/*
 * 文件管理要的 Windows 专属原语（FUTURE.md 功能 15 的第 1、2、4 条）。
 *
 * 为什么单独一个文件、不塞进 `files.rs`：这三件事都必须碰 Win32（回收站、锁卷弹出、
 * 读盘镜像的文件头），放一块便于逐句复核 unsafe 块。非 Windows 平台一律报
 * 「这台机器上不支持」，界面据此把入口藏起来 —— **不摆按了没反应的按钮**，
 * 和 0.1.60 那次「只加一个命令、不做假按钮」的处理一致。
 *
 * 名字里的 fs 是「文件系统」：`files.rs` 管的是跨平台的通用文件操作，这里管
 * 「只有 Windows 才拿得到的文件系统能力」。
 */
use serde::Serialize;

use crate::files::FileError;
use crate::i18n::pick;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleBinInfo {
    /// 这台机器能不能查 / 清空回收站。false 时前端把这一项整个藏起来。
    pub supported: bool,
    pub bytes: u64,
    pub items: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleBinEmpty {
    /// 清出来多少字节（以清之前查到的量为准）。
    pub freed: u64,
    /// 清掉多少项。
    pub items: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscProbe {
    /// `ps2` / `psp` / `iso` / `unknown`。
    pub kind: String,
    /// 文件头前 4 字节的十六进制（给用户看的证据，认不出时显示这个）。
    pub magic: String,
}

#[tauri::command]
pub async fn recycle_bin_info() -> RecycleBinInfo {
    crate::off_main(move || {
        #[cfg(windows)]
        {
            let Some((bytes, items)) = query_recycle_bin() else {
                return RecycleBinInfo { supported: false, bytes: 0, items: 0 };
            };
            RecycleBinInfo { supported: true, bytes, items }
        }
        #[cfg(not(windows))]
        {
            // macOS 上「废纸篓」是 Finder 的目录，没有可查的 API；与其猜一个路径，
            // 不如如实说没有。
            RecycleBinInfo { supported: false, bytes: 0, items: 0 }
        }
    })
    .await
    .unwrap_or(RecycleBinInfo { supported: false, bytes: 0, items: 0 })
}

/// 清空回收站。**不做二次确认**：向导第 3 步的总量摘要就是确认那一步，
/// 系统再弹一次「确定吗」等于同一个问题问两遍。
#[tauri::command]
pub async fn recycle_bin_empty() -> Result<RecycleBinEmpty, FileError> {
    crate::off_main(empty_recycle_bin_now).await.map_err(FileError::raw)?
}

/// 安全弹出：锁卷 → 卸载 → （尽力）弹介质。
///
/// 为什么不用 `CM_Request_Device_Eject`：那要先用 SetupAPI 把盘符反查成设备实例；
/// 而**锁 + 卸载**已经做到了用户要的那件事 —— 写缓存落盘、盘符消失、可以拔了。
#[tauri::command]
pub async fn file_eject(drive: String) -> Result<(), FileError> {
    crate::off_main(move || eject_now(&drive)).await.map_err(FileError::raw)?
}

/// 读盘镜像的文件头，认它到底是哪个平台的盘（改造包 §2.4 的「扩展名 + 魔数」）。
#[tauri::command]
pub async fn file_probe_disc(path: String) -> Result<DiscProbe, FileError> {
    crate::off_main(move || probe_disc(&path)).await.map_err(FileError::raw)?
}

// ---------------------------------------------------------------- 盘镜像魔数

/// 读多少字节：要看偏移 `0x8000` 上那几个字节（UMD 卷标 / ISO9660 描述符），
/// 所以最少 32 KiB 多一点。一次读掉，别为了 8 个字节 seek 两趟。
const DISC_PROBE_BYTES: usize = 0x8000 + 16;

/// 盘镜像的判定，越具体越先判：
///   1. 偏移 0 的 `00 00 00 20` → PS2（改造包 §2.4 指定的那一条）
///   2. 偏移 0x8000 的 `PSP GAME` → PSP（UMD 的卷标就在第 16 扇区）
///   3. 偏移 0x8001 的 `CD001` → 通用 ISO9660（PS1 的盘也落这儿，归「光碟」）
///
/// 都不中就返回 `unknown`：前端把这一组交给用户自己指定目标，**不瞎猜**。
fn probe_disc(path: &str) -> Result<DiscProbe, FileError> {
    use std::io::Read;

    let mut file = std::fs::File::open(std::path::Path::new(path))
        .map_err(|err| FileError::io("打不开这个镜像", "Couldn't open the image", &err))?;
    let mut head = vec![0u8; DISC_PROBE_BYTES];
    // 小于 32 KiB 的镜像照样能判（读多少算多少）：短读不是错误。
    let read = file.read(&mut head).unwrap_or(0);
    head.truncate(read);
    let magic = head
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    let kind = if head.starts_with(&[0x00, 0x00, 0x00, 0x20]) {
        "ps2"
    } else if bytes_at(&head, 0x8000, b"PSP GAME") {
        "psp"
    } else if bytes_at(&head, 0x8001, b"CD001") {
        "iso"
    } else {
        "unknown"
    };
    Ok(DiscProbe { kind: kind.to_string(), magic })
}

fn bytes_at(head: &[u8], offset: usize, needle: &[u8]) -> bool {
    head.len() >= offset + needle.len() && &head[offset..offset + needle.len()] == needle
}

// ---------------------------------------------------------------- 回收站（Windows）

#[cfg(windows)]
fn query_recycle_bin() -> Option<(u64, u64)> {
    use windows_sys::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};

    let mut info = SHQUERYRBINFO {
        // cbSize 必须按结构体的真实大小填：API 靠它认版本。
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        i64Size: 0,
        i64NumItems: 0,
    };
    // pszRootPath 传 NULL = 问「本机所有盘的合计」（文档原话）。不自己遍历盘符：
    // 掌机上 SD 卡 / U 盘换来换去，遍历反而更容易漏一块或撞上刚拔掉的盘。
    // SAFETY: 只把这个栈上的 info 交给 API，cbSize 已填好，调用期间它不会被移动。
    let hr = unsafe { SHQueryRecycleBinW(std::ptr::null(), &mut info) };
    if hr < 0 {
        // 查不出来不算错误：调用方据此把这一项从「清理空间」里拿掉。
        return None;
    }
    Some((info.i64Size.max(0) as u64, info.i64NumItems.max(0) as u64))
}

#[cfg(windows)]
fn empty_recycle_bin_now() -> Result<RecycleBinEmpty, FileError> {
    use windows_sys::Win32::UI::Shell::{
        SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
    };

    let before = query_recycle_bin();
    // 三个 flag 全给：确认在向导第 3 步做过了；进度窗和提示音在整屏界面里只会挡路，
    // 掌机上还会把焦点抢走（这时手柄按什么都没反应，用户以为卡死了）。
    // SAFETY: 三个参数都是本次调用自己的常量或空值，不涉及调用方持有的内存。
    let hr = unsafe {
        SHEmptyRecycleBinW(
            std::ptr::null_mut(),
            std::ptr::null(),
            SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND,
        )
    };
    let after = query_recycle_bin();
    // 回收站本来就空的时候这个 API 会返回失败（E_UNEXPECTED）——「没什么好清的」
    // 对用户不是错误。所以以「清完还剩多少」为准，返回值只当参考。
    if hr < 0 && after.is_some_and(|(bytes, _)| bytes > 0) {
        return Err(FileError::new(
            "recycle",
            pick("系统没能清空回收站", "Windows couldn't empty the Recycle Bin"),
        ));
    }
    let (freed, items) = match (before, after) {
        (Some((was, count)), Some((now, _))) => (was.saturating_sub(now), count),
        (Some((was, count)), None) => (was, count),
        _ => (0, 0),
    };
    Ok(RecycleBinEmpty { freed, items })
}

#[cfg(not(windows))]
fn empty_recycle_bin_now() -> Result<RecycleBinEmpty, FileError> {
    Err(FileError::rule(pick(
        "这台机器上没有回收站可以清",
        "There's no Recycle Bin to empty on this machine",
    )))
}
// ---------------------------------------------------------------- 安全弹出（Windows）

/// 锁卷最多试几次 / 每次隔多久。
///
/// 为什么要重试：资源管理器只要还停在这块盘的目录上，第一次锁必然失败 ——
/// 直接回一句「设备忙」，用户根本不知道是哪个程序占着。
#[cfg(windows)]
const LOCK_ATTEMPTS: u32 = 6;
#[cfg(windows)]
const LOCK_RETRY: std::time::Duration = std::time::Duration::from_millis(250);

/// 盘符 → Win32 认的设备路径：`E:` / `E:\` / `e:/` → `\\.\E:`。
#[cfg(windows)]
fn volume_device_path(drive: &str) -> Option<String> {
    let trimmed = drive.trim().trim_end_matches(['\\', '/']);
    let mut chars = trimmed.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_alphabetic() || chars.next() != Some(':') || chars.next().is_some() {
        return None;
    }
    Some(format!("\\\\.\\{letter}:"))
}

#[cfg(windows)]
fn eject_now(drive: &str) -> Result<(), FileError> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::{
        FSCTL_DISMOUNT_VOLUME, FSCTL_LOCK_VOLUME, IOCTL_STORAGE_EJECT_MEDIA,
    };

    let Some(device) = volume_device_path(drive) else {
        return Err(FileError::rule(pick(
            "只能弹出盘符（例如 E:）",
            "Only a drive letter (like E:) can be ejected",
        )));
    };
    let wide: Vec<u16> = device.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: wide 活到调用结束；下面所有 ioctl 用的都是这次拿到的句柄，函数结尾
    // 一定会 CloseHandle，不会漏。
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(FileError::new(
            "locked",
            pick(
                "打不开这块盘（可能已经弹出，或者它不是盘符）",
                "Couldn't open that drive (maybe it's already ejected)",
            ),
        ));
    }
    let result: Result<(), FileError> = (|| {
        let mut locked = false;
        for _ in 0..LOCK_ATTEMPTS {
            // SAFETY: 句柄来自上面的 CreateFileW 且此刻仍未关闭；FSCTL_LOCK_VOLUME
            // 不带输入 / 输出缓冲，两头都传空。
            if unsafe { ioctl(handle, FSCTL_LOCK_VOLUME) } {
                locked = true;
                break;
            }
            std::thread::sleep(LOCK_RETRY);
        }
        if !locked {
            return Err(FileError::new(
                "locked",
                pick(
                    "有程序正开着这块盘，先关掉它的窗口再试",
                    "Something is using that drive — close its folder windows and retry",
                ),
            ));
        }
        // 卸载卷：这一步之后盘符从系统里消失，写缓存也就落盘了 —— 这才是「能安全拔」
        // 的实际含义。失败也往下走，后面弹介质可能仍然能成。
        // SAFETY: 同上，句柄有效且未关闭。
        let _ = unsafe { ioctl(handle, FSCTL_DISMOUNT_VOLUME) };
        // 弹介质对固定盘（内置 SSD）必然失败 —— 不是错误：锁 + 卸载已经够了。
        // SAFETY: 同上。
        let _ = unsafe { ioctl(handle, IOCTL_STORAGE_EJECT_MEDIA) };
        Ok(())
    })();
    // SAFETY: handle 有效，且上面所有 ioctl 都用完了，此刻才关。
    unsafe { CloseHandle(handle) };

#[cfg(test)]
mod tests {
    use super::*;

    /// 盘符规整：三种写法都要认，别的一律拒绝 —— 宁可不做，也别对奇怪的路径发 FSCTL。
    #[test]
    #[cfg(windows)]
    fn volume_path_normalizes_drive_letters() {
        assert_eq!(volume_device_path("E:").unwrap(), "\\\\.\\E:");
        assert_eq!(volume_device_path(" D:/ ").unwrap(), "\\\\.\\D:");
        assert!(volume_device_path("switch").is_none());
        assert!(volume_device_path("E:\\ROMs").is_none());
    }

    #[test]
    fn bytes_at_only_matches_inside_the_buffer() {
        let head = vec![0u8; 16];
        assert!(bytes_at(&head, 0, &[0u8; 4]));
        assert!(!bytes_at(&head, 8, &[0u8; 16]));
        assert!(!bytes_at(&head, 0, &[1u8; 1]));
    }

    /// 凑不出魔数的文件必须落到 `unknown`，**不许**默认当 PS2 —— 猜错平台会把 ROM
    /// 送进错误的模拟器目录，用户下次就找不到自己的游戏了。
    #[test]
    fn probe_disc_reports_unknown_for_filler() {
        let dir = std::env::temp_dir().join("fh-probe-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("filler.iso");
        std::fs::write(&path, vec![0xAAu8; 64]).unwrap();
        let probe = probe_disc(path.to_str().unwrap()).unwrap();
        assert_eq!(probe.kind, "unknown");
        assert_eq!(probe.magic, "AA AA AA AA");
        let _ = std::fs::remove_file(&path);

        // PS2 的判据就是偏移 0 的 00 00 00 20。
        let ps2 = dir.join("ps2.iso");
        let mut body = vec![0x00u8, 0x00, 0x00, 0x20];
        body.resize(64, 0);
        std::fs::write(&ps2, &body).unwrap();
        assert_eq!(probe_disc(ps2.to_str().unwrap()).unwrap().kind, "ps2");
        let _ = std::fs::remove_file(&ps2);
    }
}

    result
}

/// 一次不带缓冲的 `DeviceIoControl`（这几个控制码都是「干活型」，不传数据）。
#[cfg(windows)]
unsafe fn ioctl(handle: windows_sys::Win32::Foundation::HANDLE, code: u32) -> bool {
    use windows_sys::Win32::System::IO::DeviceIoControl;

    let mut returned = 0u32;
    DeviceIoControl(
        handle,
        code,
        std::ptr::null(),
        0,
        std::ptr::null_mut(),
        0,
        &mut returned,
        std::ptr::null_mut(),
    ) != 0
}

#[cfg(not(windows))]
fn eject_now(_drive: &str) -> Result<(), FileError> {
    Err(FileError::rule(pick(
        "这台机器上不支持安全弹出",
        "Safe eject isn't available on this machine",
    )))
}

