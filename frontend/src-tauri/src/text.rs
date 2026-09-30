//! 托盘与浮层的文案。
//!
//! 阶段 2 的过渡方案：跟随系统 UI 语言。阶段 3/4 接上共享设置文件
//! （`%APPDATA%\handheld-launcher\settings.json` 的 `locale`，见 FRONTEND.md §6）后，
//! 这里只留 `pick`。

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn apply_system_locale() {
    ENGLISH.store(is_english_system(), Ordering::Relaxed);
}

#[cfg(windows)]
fn is_english_system() -> bool {
    // LANGID 的低 10 位是主语言 ID，9 = English。
    let langid = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
    langid & 0x3ff == 9
}

#[cfg(not(windows))]
fn is_english_system() -> bool {
    std::env::var("LANG")
        .map(|lang| lang.to_ascii_lowercase().starts_with("en"))
        .unwrap_or(false)
}

pub fn pick(zh: &str, en: &str) -> String {
    if ENGLISH.load(Ordering::Relaxed) {
        en.to_string()
    } else {
        zh.to_string()
    }
}

pub fn tooltip() -> String {
    pick(
        "幻想前端（Ctrl+H / 手柄 Back+Start 开关）",
        "FantasyHub Frontend (Ctrl+H / Back+Start)",
    )
}

pub fn toggle() -> String {
    pick("显示 / 隐藏前端", "Show / hide")
}

pub fn autostart() -> String {
    pick("开机自启", "Start with Windows")
}

pub fn quit() -> String {
    pick("退出前端", "Quit")
}
