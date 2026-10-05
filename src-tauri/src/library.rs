//! 「库里有哪些游戏」的清单文件。
//!
//! 库本身存在启动器的 localStorage 里（WebView2 的 user-data 目录按 app identifier 分开，
//! 小组件那边是 UWP 沙箱，两边都读不到对方），所以由界面在每个游戏列表变化时通过
//! [`library_publish`] 落盘成 `%APPDATA%\handheld-launcher\library.json`，
//! 小组件后端读它来判断「哪个游戏在跑 / 退掉它」。
//!
//! 这段原来是 `fh-core::library`（独立前端也要读同一份），2026-10-05 独立前端删掉后
//! 只有启动器自己用，就搬进 app 里，不再占共享内核的位置。
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 库里的一个游戏（发布给小组件的那份清单，字段名与 C# 侧读的一致）。
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
    // 先写临时文件再改名：读这份文件的不只有界面，小组件后端随时可能来读，
    // 绝不能让它读到半截 JSON。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|err| err.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|err| err.to_string())
}

/// 读清单。文件不存在（界面还没发布过）就是空表 —— 小组件那边表现为「没有可退出的游戏」，
/// 而不是报错。
pub fn read_published() -> Vec<LibraryGame> {
    let path = published_path();
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&body).unwrap_or_default()
}

/// 界面的库变化时（扫描完 / 加游戏 / 改路径 / 藏起来）把清单发布出去。
///
/// 这份清单现在是**两个**读者：启动器自己的小组件后端（用来判断哪个游戏在跑、
/// 发布 quit_game 的候选）。**只读数据**，不构成控制通道。
#[tauri::command]
pub async fn library_publish(items: Vec<LibraryGame>) -> Result<usize, String> {
    let count = items.len();
    match crate::off_main(move || write_published(&items)).await {
        Ok(result) => {
            result?;
            crate::logutil::write_line(&format!("library published count={count}"));
            Ok(count)
        }
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_shape_is_camel_case_and_tolerates_missing_fields() {
        let raw = r#"[{"id":"steam:1","name":"A","launchPath":"C:\\a.exe","installPath":"C:\\a"},
                      {"id":"epic:2","launchPath":"","installPath":""}]"#;
        let games: Vec<LibraryGame> = serde_json::from_str(raw).unwrap();
        assert_eq!(games[0].launch_path, "C:\\a.exe");
        // 缺字段（老清单 / 手改过的文件）也要能解析：整份清单不能因为一个游戏没名字就读不出来，
        // 否则小组件的游戏列表会直接变空。
        assert_eq!(games[1].name, "");
        let round: Vec<LibraryGame> = serde_json::from_str(&serde_json::to_string(&games).unwrap()).unwrap();
        assert_eq!(round[1].id, "epic:2");
    }
}
