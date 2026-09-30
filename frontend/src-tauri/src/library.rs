//! 读启动器发布的库清单（**只读**）。
//!
//! 库本身存在启动器的 localStorage 里（WebView2 的 user-data 目录按 app identifier 分开，
//! 前端读不到），所以由启动器把它落成 `library.json`，前端读这个文件。文件不在
//! （启动器没发布过）就是空表：前端自己判断进程的能力不依赖启动器在不在运行。

use fh_core::library::LibraryGame;

#[tauri::command]
pub async fn library_read() -> Vec<LibraryGame> {
    crate::off_main(fh_core::library::read_published)
        .await
        .unwrap_or_default()
}
