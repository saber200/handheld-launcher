//! 托盘：显示/隐藏、开机自启、退出。
//!
//! 前端是托盘常驻软件 —— 左键点图标或菜单第一项都是「开关浮层」，
//! 「退出」是**唯一**能真正结束进程的入口（关窗只隐藏，见 overlay.rs）。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::{overlay, text};

/// 需要改勾选状态的菜单项，存进应用状态备用。
pub struct TrayItems {
    pub autostart: CheckMenuItem<Wry>,
    retry_autostart: std::sync::atomic::AtomicI8,
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let initial_state = autostart_enabled(app);
    let autostart_on = initial_state.as_ref().copied().unwrap_or(false);
    let toggle = MenuItem::with_id(app, "toggle", text::toggle(), true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        text::autostart(),
        true,
        autostart_on,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", text::quit(), true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::new()
        .tooltip(text::tooltip())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id: &str = event.id.as_ref();
            match id {
                "toggle" => overlay::toggle(app, "tray menu"),
                "autostart" => {
                    match autostart_enabled(app) {
                        Ok(state) => {
                            let retry = app.try_state::<TrayItems>().and_then(|items| {
                                match items.retry_autostart.load(std::sync::atomic::Ordering::Relaxed) {
                                    0 => Some(false),
                                    1 => Some(true),
                                    _ => None,
                                }
                            });
                            // 上次部分失败时重试原目标，而不是反转已生效的任务状态。
                            let _ = set_autostart(app, retry.unwrap_or(!state));
                        }
                        Err(err) => report_autostart_error(app, &err),
                    }
                }
                "quit" => quit_now(app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                overlay::toggle(tray.app_handle(), "tray click");
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;

    app.manage(TrayItems { autostart, retry_autostart: std::sync::atomic::AtomicI8::new(-1) });
    fh_core::logutil::write_line(&format!("tray installed autostart={initial_state:?}"));
    if let Err(err) = initial_state {
        report_autostart_error(app, &err);
    }
    Ok(())
}

pub fn autostart_enabled(app: &AppHandle) -> Result<bool, String> {
    #[cfg(windows)]
    match fh_core::autostart::task_state()? {
        fh_core::autostart::TaskState::Enabled => return Ok(true),
        fh_core::autostart::TaskState::Disabled => return Ok(false),
        fh_core::autostart::TaskState::Missing => {}
    }
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|err| format!("查询旧自启项失败：{err}"))
}

/// 前端自己管自启。**0.1.53 起优先用计划任务**（`fh_core::autostart`）：
/// Run 键由 explorer 处理，Xbox 模式（全屏体验）的会话里根本没有 explorer，
/// 于是「开机后前端不在」；任务由任务计划程序拉起，并且崩了会被拉回、优雅退出不会重启。
/// Run 键保留为**兜底**：独立安装（没有启动器）时任务可能建不出来，那时还得靠它。
pub fn set_autostart(app: &AppHandle, on: bool) -> Result<bool, String> {
    let result = (|| -> Result<bool, String> {
        #[cfg(windows)]
        match fh_core::autostart::task_state()? {
            fh_core::autostart::TaskState::Enabled | fh_core::autostart::TaskState::Disabled => {
                fh_core::autostart::set_task_enabled(on)?;
                // 标记失败也尝试清旧 Run；两个错误都必须反馈。
                let marker = fh_core::autostart::set_autostart_switch(on);
                let cleanup = fh_core::autostart::cleanup_legacy_run();
                combine_results(marker, cleanup)?;
                return verify_autostart(app, on);
            }
            fh_core::autostart::TaskState::Missing => {}
        }
        use tauri_plugin_autostart::ManagerExt;
        let autolaunch = app.autolaunch();
        if on { autolaunch.enable() } else { autolaunch.disable() }
            .map_err(|err| format!("设置旧自启项失败：{err}"))?;
        fh_core::autostart::set_autostart_switch(on)?;
        verify_autostart(app, on)
    })();
    if let Some(items) = app.try_state::<TrayItems>() {
        items.retry_autostart.store(
            if result.is_err() { i8::from(on) } else { -1 },
            std::sync::atomic::Ordering::Relaxed,
        );
    }
    fh_core::logutil::write_line(&format!("autostart set on={on} result={result:?}"));
    match &result {
        Ok(state) => update_autostart_menu(app, Some(*state), false),
        Err(err) => report_autostart_error(app, err),
    }
    result
}

#[cfg(windows)]
fn combine_results(first: Result<(), String>, second: Result<(), String>) -> Result<(), String> {
    match (first, second) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(err), Ok(())) | (Ok(()), Err(err)) => Err(err),
        (Err(first), Err(second)) => Err(format!("{first}; {second}")),
    }
}

fn verify_autostart(app: &AppHandle, expected: bool) -> Result<bool, String> {
    let actual = autostart_enabled(app)?;
    if actual == expected { Ok(actual) }
    else { Err(format!("自启状态核验失败：期望 {expected}，实际 {actual}")) }
}

fn update_autostart_menu(app: &AppHandle, state: Option<bool>, failed: bool) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let label = match (state, failed) {
            (None, _) => format!("{}（状态未知，点击重试）", text::autostart()),
            (_, true) => format!("{}（操作失败，点击重试）", text::autostart()),
            _ => text::autostart(),
        };
        if let Err(err) = items.autostart.set_checked(state.unwrap_or(false)) {
            fh_core::logutil::write_line(&format!("autostart menu check failed: {err}"));
        }
        if let Err(err) = items.autostart.set_text(label) {
            fh_core::logutil::write_line(&format!("autostart menu label failed: {err}"));
        }
    }
}

fn report_autostart_error(app: &AppHandle, error: &str) {
    let state = match autostart_enabled(app) {
        Ok(state) => Some(state),
        Err(err) => {
            fh_core::logutil::write_line(&format!("autostart refresh failed: {err}"));
            None
        }
    };
    update_autostart_menu(app, state, true);
    show_error(error);
}

fn show_error(error: &str) {
    fh_core::logutil::write_line(&format!("autostart error: {error}"));
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let title: Vec<u16> = "FantasyHub 自启设置失败\0".encode_utf16().collect();
        let message: Vec<u16> = format!("{error}\n\n操作可能已部分生效，请检查任务状态后重试。\0")
            .encode_utf16().collect();
        unsafe { MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR); }
    }
}

fn quit_now(app: &AppHandle) {
    // 意图落盘失败则保留进程，避免启动器再次补拉。
    if let Err(err) = fh_core::autostart::mark_stopped() {
        show_error(&err);
        return;
    }
    overlay::request_quit();
    fh_core::logutil::write_line("frontend quit (tray menu)");
    app.exit(0);
}
