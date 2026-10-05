//! 文案选择：逻辑在共享内核里（独立前端也要用同一套），这里只保留命令外壳。
//!
//! 命令必须留在 app 自己的 crate 里：Tauri 的 `allow-<命令名>` 权限是构建时按 app 源码
//! 生成的，搬进依赖 crate 会扫不到（见 `fh-core/src/lib.rs` 顶部的铁律）。

pub use fh_core::i18n::{apply, pick};

/// 当前语言，给小组件的 `status.locale` 用（C# 侧只认 `zh-CN` / `en-US` 两种字面量）。
pub fn locale() -> &'static str {
    if fh_core::i18n::english() { "en-US" } else { "zh-CN" }
}

#[tauri::command]
pub fn set_locale(locale: String) {
    apply(&locale);
}
