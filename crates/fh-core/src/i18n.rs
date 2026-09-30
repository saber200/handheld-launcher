//! 中英文文案选择（两个程序共用）。
//!
//! 命令不在这里 —— 各 app 自己声明 `#[tauri::command] set_locale` 薄薄地调 [`apply`]
//! （见 lib.rs 顶部的铁律说明）。

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn apply(locale: &str) {
    ENGLISH.store(
        locale.to_ascii_lowercase().starts_with("en"),
        Ordering::Relaxed,
    );
}

pub fn english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

pub fn pick(zh: &str, en: &str) -> String {
    if ENGLISH.load(Ordering::Relaxed) {
        en.to_string()
    } else {
        zh.to_string()
    }
}
