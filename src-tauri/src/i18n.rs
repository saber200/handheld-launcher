use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn apply(locale: &str) {
    ENGLISH.store(
        locale.to_ascii_lowercase().starts_with("en"),
        Ordering::Relaxed,
    );
}

pub fn pick(zh: &str, en: &str) -> String {
    if ENGLISH.load(Ordering::Relaxed) {
        en.to_string()
    } else {
        zh.to_string()
    }
}

#[tauri::command]
pub fn set_locale(locale: String) {
    apply(&locale);
}
