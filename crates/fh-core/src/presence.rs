//! 独立前端"我装在哪、什么版本"的记录。
//!
//! 前端每次启动写一次 `%APPDATA%\handheld-launcher\frontend.json`；启动器的工具箱卡片
//! 读它来显示"已安装 / 未安装"。为什么不猜安装目录：NSIS 的安装位置随安装模式变，
//! 猜错就会显示错误的安装状态；由前端自己报最准，也顺带说明"它至少跑过一次"。
//! 纯数据，前端写、启动器读，反过来没有通道。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    /// 前端自己的可执行文件路径。
    pub exe: String,
    pub version: String,
    /// 最近一次启动的 Unix 秒。
    pub seen_at: u64,
}

pub fn published_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata)
                .join("handheld-launcher")
                .join("frontend.json");
        }
    }
    std::env::temp_dir().join("fantasyhub-frontend.json")
}

/// 前端启动时调用。拿不到自己的路径也不影响运行，只记日志。
pub fn record(version: &str) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let seen_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let body = serde_json::to_string(&Presence {
        exe,
        version: version.to_string(),
        seen_at,
    })
    .map_err(|err| err.to_string())?;
    let path = published_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|err| err.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|err| err.to_string())
}

/// 启动器侧读取；没装过/没跑过就是 `None`。
pub fn read() -> Option<Presence> {
    let body = std::fs::read_to_string(published_path()).ok()?;
    serde_json::from_str(&body).ok()
}
