//! 把库清单发布给独立前端。
//!
//! 前端的 localStorage 和启动器的不是一份（WebView2 的 user-data 目录按 app identifier
//! 分开），所以库数据由启动器在这里落盘成 `library.json`，前端只读它来判断
//! 「哪个游戏在跑 / 退掉它」。前端**只读**，启动器不借此获得任何对前端的控制能力。
//! 数据结构在 `fh_core::library`，两个程序共用。

use fh_core::library::LibraryGame;

#[tauri::command]
pub async fn library_publish(items: Vec<LibraryGame>) -> Result<usize, String> {
    let count = items.len();
    match crate::off_main(move || fh_core::library::write_published(&items)).await {
        Ok(result) => {
            result?;
            crate::logutil::write_line(&format!("library published count={count}"));
            Ok(count)
        }
        Err(err) => Err(err),
    }
}
