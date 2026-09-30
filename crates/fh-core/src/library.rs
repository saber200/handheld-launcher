//! 「库里有哪些游戏」的共享清单。
//!
//! 为什么要有这个文件：库本身存在**启动器自己的 localStorage** 里（WebView2 的
//! user-data 目录是按 app identifier 分开的），独立前端读不到。于是让启动器把清单
//! 发布到 `%APPDATA%\handheld-launcher\library.json`，前端只读它 —— 这样前端就能
//! 自己判断「哪个游戏在跑 / 退掉它」，不需要向启动器发指令，启动器没运行也能用。
//!
//! 这只是一份**数据**，不是控制通道：启动器不因它获得任何对前端的控制能力。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGame {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub launch_path: String,
    #[serde(default)]
    pub install_path: String,
}

pub fn published_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata)
                .join("handheld-launcher")
                .join("library.json");
        }
    }
    std::env::temp_dir().join("fantasyhub-library.json")
}

/// 启动器调用：把当前库里的游戏清单落盘。
pub fn write_published(games: &[LibraryGame]) -> Result<(), String> {
    let path = published_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let body = serde_json::to_string(games).map_err(|err| err.to_string())?;
    // 先写临时文件再改名：前端随时可能来读，绝不能读到半截 JSON。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|err| err.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|err| err.to_string())
}

/// 前端调用：读清单。文件不存在（启动器还没发布过）就返回空表。
pub fn read_published() -> Vec<LibraryGame> {
    let path = published_path();
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&body).unwrap_or_default()
}
