//! 后台与托盘文案；Widget 切换语言时与共享核心同步。
use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn apply_system_locale() {
    apply(if is_english_system() { "en-US" } else { "zh-CN" });
}

pub fn apply(locale: &str) {
    ENGLISH.store(locale == "en-US", Ordering::Relaxed);
    fh_core::i18n::apply(locale);
}

pub fn locale() -> &'static str {
    if ENGLISH.load(Ordering::Relaxed) { "en-US" } else { "zh-CN" }
}

#[cfg(windows)]
fn is_english_system() -> bool {
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
    if ENGLISH.load(Ordering::Relaxed) { en.to_string() } else { zh.to_string() }
}

pub fn tooltip() -> String {
    pick("幻想前端 — Game Bar 后台", "FantasyHub — Game Bar backend")
}

pub fn gamebar_hint() -> String {
    pick(
        "按 Win+G → 小组件菜单 → FantasyHub",
        "Press Win+G → Widget menu → FantasyHub",
    )
}

pub fn autostart() -> String {
    pick("开机自启", "Start with Windows")
}

pub fn autostart_label(known: bool, failed: bool) -> String {
    let suffix = if !known {
        pick("（状态未知，点击重试）", " (unknown; click to retry)")
    } else if failed {
        pick("（操作失败，点击重试）", " (failed; click to retry)")
    } else {
        String::new()
    };
    format!("{}{suffix}", autostart())
}

pub fn quit() -> String {
    pick("退出前端", "Quit backend")
}

pub fn quit_failed() -> String {
    pick("退出意图保存失败，点击重试", "Could not save quit intent; retry")
}

#[cfg(test)]
mod tests {
    #[test]
    fn locale_sync() { super::apply("en-US"); assert_eq!(super::locale(), "en-US"); super::apply("zh-CN"); assert_eq!(super::locale(), "zh-CN"); }
}