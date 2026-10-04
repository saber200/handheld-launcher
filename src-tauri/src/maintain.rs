/*
 * 工具箱 →「系统维护」卡（FUTURE.md 功能 14 的第 2、3 条）。
 *
 * 画板上这张卡是三行实数 + 一颗「立即清理」（着色器缓存 3.2 GB / 启动项 4 个 / 日志 12 MB）。
 * 0.1.60 那版写的是「这一版还没接」—— 它要的是新的系统信息与清理命令，这一版补上。
 * 数字全部来自真实读取；读不到就由界面写「—」，**不摆假数字**。
 *
 * 为什么单独一个文件：这三件事都要读系统（显卡缓存目录、注册表启动项、自己的日志目录），
 * 和 toolbox.rs 里「装驱动 / 装运行库 / 装卸 Mod」那几条不是一类事，混进去只会让那近两千行
 * 更难读。
 */
use serde::Serialize;

use crate::files::FileError;
use crate::i18n::pick;

/// 量目录大小的预算：掌机上不能让「自检」卡在一个几万文件的缓存目录上。
const MEASURE_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceScan {
    /// 着色器缓存合计（只算下面 `cache_roots()` 里那几个已知目录）。
    pub shader_cache_bytes: u64,
    /// 量到几个非空缓存目录（0 表示「本来就没有」，不是「读失败」）。
    pub shader_cache_dirs: u32,
    /// 开机启动项条数（HKCU + HKLM 的 Run 键）。**只读**：替用户改开机启动是另一回事，
    /// 画板上也只有条数。
    pub startup_items: u32,
    pub log_bytes: u64,
    /// 日志目录（界面把它显示出来，用户想自己看的时候知道去哪）。
    pub log_dir: String,
    /// 这台机器上能不能读到上面这些数（macOS 为 false，界面直接写「—」）。
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceClean {
    /// 清出来多少字节（按清理前量到的数）。
    pub freed: u64,
    /// 真正删掉的缓存目录数。
    pub caches: u32,
    /// 删掉的日志文件数（正在写的那个删不掉，不计）。
    pub log_files: u32,
}

#[tauri::command]
pub async fn toolbox_maintenance() -> MaintenanceScan {
    crate::off_main(scan_now).await.unwrap_or_else(|_| MaintenanceScan {
        shader_cache_bytes: 0,
        shader_cache_dirs: 0,
        startup_items: 0,
        log_bytes: 0,
        log_dir: String::new(),
        supported: false,
    })
}

/// 「立即清理」：删掉那几个缓存目录 + 启动器自己的日志文件。
///
/// 为什么敢直接删目录而不是往里挑文件：这些都是**缓存**（驱动与 Steam 会自己重建），
/// 删掉不会丢用户数据；而日志只删我们自己的（`logutil::dir()`），不碰任何游戏日志。
/// 正在写的那个日志文件在 Windows 上删不掉（被占用），那就跳过、如实计数 —— 不假装清干净了。
#[tauri::command]
pub async fn toolbox_maintenance_clean() -> Result<MaintenanceClean, FileError> {
    crate::off_main(clean_now).await.map_err(FileError::raw)?
}

fn scan_now() -> MaintenanceScan {
    let deadline = std::time::Instant::now() + MEASURE_BUDGET;
    let mut shader_cache_bytes = 0u64;
    let mut shader_cache_dirs = 0u32;
    for root in cache_roots() {
        let (bytes, _complete) = crate::files::dir_bytes_until(&root, deadline);
        if bytes == 0 {
            continue;
        }
        shader_cache_bytes += bytes;
        shader_cache_dirs += 1;
    }
    let (log_bytes, log_dir) = log_usage();
    MaintenanceScan {
        shader_cache_bytes,
        shader_cache_dirs,
        startup_items: startup_item_count(),
        log_bytes,
        log_dir,
        supported: cfg!(windows),
    }
}

fn clean_now() -> Result<MaintenanceClean, FileError> {
    if !cfg!(windows) {
        return Err(FileError::rule(pick(
            "系统维护只在 Windows 掌机上有意义",
            "System maintenance only applies on the Windows handheld",
        )));
    }
    let deadline = std::time::Instant::now() + MEASURE_BUDGET;
    let mut freed = 0u64;
    let mut caches = 0u32;
    for root in cache_roots() {
        let (bytes, _) = crate::files::dir_bytes_until(&root, deadline);
        if bytes == 0 {
            continue;
        }
        if std::fs::remove_dir_all(&root).is_ok() {
            freed += bytes;
            caches += 1;
        }
    }
    let mut log_files = 0u32;
    for (path, bytes) in log_files_on_disk() {
        if std::fs::remove_file(&path).is_ok() {
            freed += bytes;
            log_files += 1;
        }
    }
    Ok(MaintenanceClean { freed, caches, log_files })
}

/// 要量的缓存目录。**只列已知的厂商缓存**（显卡驱动 + Steam），不遍历整块盘 ——
/// 掌机上「扫全盘」几秒钟出不来数，用户会以为卡死了。
fn cache_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from) {
        for relative in [
            r"NVIDIA\DXCache",
            r"NVIDIA\GLCache",
            r"NVIDIA Corporation\NV_Cache",
            r"AMD\DxCache",
            r"AMD\GLCache",
            r"AMD\DxcCache",
            r"Intel\ShaderCache",
        ] {
            roots.push(local.join(relative));
        }
    }
    #[cfg(windows)]
    {
        // Steam 的 shadercache 往往是最大的一块（画板上那个 3.2 GB 多半就是它）。
        // 安装根与库根的解析复用 scan.rs 那一套（注册表 + libraryfolders.vdf），
        // 不再抄第二份 —— 抄了就会有两份「Steam 装在哪」的答案。
        for library in crate::scan::steam_library_roots() {
            roots.push(library.join("steamapps").join("shadercache"));
        }
    }
    roots.retain(|path| path.is_dir());
    roots
}

/// 日志目录与它的占用（`logutil::dir()` = `%APPDATA%\handheld-launcher`）。
/// 不返回错误：读不到就是 0 / 空串，界面写「—」。
fn log_usage() -> (u64, String) {
    let dir = fh_core::logutil::dir();
    let files = log_files_on_disk();
    let bytes = files.iter().map(|(_, size)| *size).sum();
    (bytes, dir.to_string_lossy().into_owned())
}

/// 日志目录里的 `*.log` 文件（路径 + 字节数）。只认 `.log` 后缀 —— 同目录下还有
/// 设置 / 账本这些 JSON，它们不是日志，不能跟着删。
fn log_files_on_disk() -> Vec<(std::path::PathBuf, u64)> {
    let Ok(read) = std::fs::read_dir(fh_core::logutil::dir()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let is_log = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("log"));
        if !is_log {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_file() {
            out.push((path, meta.len()));
        }
    }
    out
}

/// 开机启动项条数。**只数**：能读就读，读不了就是 0。
#[cfg(windows)]
fn startup_item_count() -> u32 {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_WOW: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";
    let mut count = 0u32;
    for path in [RUN, RUN_WOW] {
        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(path) {
            count += key.enum_values().count() as u32;
        }
    }
    // HKLM 的 32 位分支在 64 位系统上要被 WOW6432Node 那条路径读到（两个写法都试，
    // 免得漏掉 32 位软件注册的启动项；重定向机制对同一个进程只会命中其中一条）。
    for path in [RUN, RUN_WOW] {
        if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(path) {
            count += key.enum_values().count() as u32;
        }
    }
    count
}

#[cfg(not(windows))]
fn startup_item_count() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 日志文件只认 `.log`：同目录下还有设置 / 账本这些 JSON，
    /// 清日志时把它们一起删掉就是事故。
    #[test]
    fn log_files_are_only_dot_log() {
        let dir = fh_core::logutil::dir();
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join("fh-test-keep.log");
        let other = dir.join("fh-test-keep.json");
        std::fs::write(&log, b"hello").unwrap();
        std::fs::write(&other, b"{}").unwrap();

        let found = log_files_on_disk();
        assert!(found.iter().any(|(path, size)| path.ends_with("fh-test-keep.log") && *size == 5));
        assert!(!found.iter().any(|(path, _)| path.ends_with("fh-test-keep.json")));

        let _ = std::fs::remove_file(&log);
        let _ = std::fs::remove_file(&other);
    }

    /// 非 Windows 上清理必须**明确报错**，而不是假装清完了：
    /// 「立即清理」这颗按钮在 macOS 上不该给人「已经清干净」的错觉。
    #[test]
    #[cfg(not(windows))]
    fn clean_reports_unsupported_off_windows() {
        assert!(clean_now().is_err());
    }
}
