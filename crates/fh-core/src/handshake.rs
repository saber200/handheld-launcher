//! 安装/更新时请正在运行的前端退出用的**一次性握手**。
//!
//! 为什么用文件而不是命名事件：握手的一端是 NSIS 安装器，NSIS 原生读写文件轻而易举，
//! 打开 Windows 命名事件却要额外插件或一大段系统调用；而文件方案两边都是十几行、
//! 没有 unsafe，失败也只是"前端没退出"，安装器照旧能给出提示。
//!
//! 流程（FRONTEND.md §5）：
//!   1. 安装器（或启动器工具箱）写下 [`marker_path`] 这个标记文件；
//!   2. 前端每隔 [`POLL_MS`] 看一眼，看到就记一行日志然后**真正退出进程**（不是隐藏）；
//!   3. 安装器等一会儿再覆盖安装，最后删掉标记文件。
//!
//! 没有前端应答时（没装 / 已经退出 / 卡住）安装器等 [`WAIT_MS`] 后继续，并在界面上提示
//! "请先在托盘退出前端"。

use std::path::PathBuf;

/// 前端检查间隔：2 秒足够快，代价可以忽略。
pub const POLL_MS: u64 = 2000;

/// 安装器最多等这么久（覆盖安装前）。
pub const WAIT_MS: u64 = 6000;

pub fn marker_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata)
                .join("handheld-launcher")
                .join("quit-for-update");
        }
    }
    std::env::temp_dir().join("fantasyhub-quit-for-update")
}

/// 安装器侧：请求前端退出。
pub fn request_quit() -> Result<(), String> {
    let path = marker_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(&path, "quit-for-update\n").map_err(|err| err.to_string())
}

/// 前端侧：只响应本进程启动之后发布的请求。
/// 以文件写入时间作为请求代际，兼容旧安装器的标记内容；新实例忽略残留请求。
pub fn quitting_requested_since(started: std::time::SystemTime) -> bool {
    marker_path()
        .metadata()
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|requested| request_targets_instance(requested, started))
}

fn request_targets_instance(
    requested: std::time::SystemTime,
    started: std::time::SystemTime,
) -> bool {
    requested > started
}

/// 安装器侧：装完收尾，清理失败不能假装成功。
pub fn clear() -> Result<(), String> {
    match std::fs::remove_file(marker_path()) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("更新退出标记清理失败：{err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::request_targets_instance;
    use std::time::{Duration, SystemTime};

    #[test]
    fn update_request_only_targets_older_instances() {
        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        let request = old + Duration::from_secs(1);
        let new = request + Duration::from_secs(1);
        assert!(request_targets_instance(request, old));
        assert!(!request_targets_instance(request, new));
        assert!(!request_targets_instance(request, request));
    }
}
