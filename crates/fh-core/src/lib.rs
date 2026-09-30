//! FantasyHub 共享内核。
//!
//! 启动器（`src-tauri`）与独立前端（`frontend/src-tauri`）共用这里的代码：
//! 日志、文案、TDP 的数据结构、库清单文件、TDP 的本地 IPC 协议与客户端、
//! 以及“哪个游戏在跑 / 退掉它”的进程逻辑。设计和边界见仓库根 FRONTEND.md。
//!
//! 铁律：本 crate 不放 `#[tauri::command]`。命令留在各自 app 里，
//! 否则构建时按 app 源码生成 `allow-<命令名>` 权限会扫不到，capability 直接报错。

pub mod handshake;
pub mod i18n;
pub mod ipc;
pub mod library;
pub mod logutil;
pub mod presence;
pub mod process;
pub mod tdp;
