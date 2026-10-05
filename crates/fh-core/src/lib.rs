//! FantasyHub 共享内核。
//!
//! 启动器（`src-tauri`）用这里的代码：日志、文案、TDP 的数据结构，
//! 以及「哪个游戏在跑 / 退掉它」的进程逻辑。设计与边界见仓库根 FRONTEND.md。
//!
//! 铁律：本 crate 不放 `#[tauri::command]`。命令留在各自 app 里，
//! 否则构建时按 app 源码生成 `allow-<命令名>` 权限会扫不到，capability 直接报错。

pub mod i18n;
pub mod logutil;
pub mod process;
pub mod tdp;
