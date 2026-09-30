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
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let autostart_on = autostart_enabled(app);
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
                    set_autostart(app, !autostart_enabled(app));
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

    app.manage(TrayItems { autostart });
    fh_core::logutil::write_line(&format!("tray installed autostart={autostart_on}"));
    Ok(())
}

pub fn autostart_enabled(app: &AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// 前端自己管自启（HKCU Run），与启动器的自启互不相干。
pub fn set_autostart(app: &AppHandle, on: bool) -> bool {
    use tauri_plugin_autostart::ManagerExt;

    let autolaunch = app.autolaunch();
    let result = if on {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    let state = autostart_enabled(app);
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.autostart.set_checked(state);
    }
    fh_core::logutil::write_line(&format!(
        "autostart set on={on} ok={} state={state}",
        result.is_ok()
    ));
    state
}

fn quit_now(app: &AppHandle) {
    overlay::request_quit();
    fh_core::logutil::write_line("frontend quit (tray menu)");
    app.exit(0);
}
