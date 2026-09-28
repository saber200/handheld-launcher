use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::i18n::pick;

const FRONTEND_LABEL: &str = "frontend";
const FRONTEND_WIDTH: f64 = 440.0;

#[tauri::command]
pub fn toggle_frontend(app: tauri::AppHandle) -> Result<bool, String> {
    crate::logutil::write_line("toggle_frontend enter");
    if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        crate::logutil::write_line(&format!("frontend exists visible={visible}"));
        if visible {
            dismiss(&app, &window);
            crate::logutil::write_line("toggle_frontend -> false (dismissed)");
            return Ok(false);
        }
        place(&window, &app);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.set_always_on_top(true);
        emit_state(&app, true);
        crate::logutil::write_line("toggle_frontend -> true (reshow)");
        return Ok(true);
    }
    create(&app)?;
    crate::logutil::write_line("toggle_frontend -> true (created)");
    Ok(true)
}

#[tauri::command]
pub fn close_frontend(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
        dismiss(&app, &window);
    } else {
        emit_state(&app, false);
        focus_main_if_idle(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn focus_frontend(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(FRONTEND_LABEL) else {
        return Ok(());
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.set_focus();
        let _ = window.set_always_on_top(true);
    }
    Ok(())
}

pub fn frontend_visible(app: &AppHandle) -> bool {
    app.get_webview_window(FRONTEND_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// True when FantasyHub itself (main or frontend) currently has keyboard focus.
pub fn software_focused(app: &AppHandle) -> bool {
    window_focused(app, "main") || window_focused(app, FRONTEND_LABEL)
}

pub fn install_hotkeys(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

        app.handle().plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["Control+H"])?
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut.matches(Modifiers::CONTROL, Code::KeyH) {
                        schedule_toggle(app, "hotkey Control+H");
                    }
                })
                .build(),
        )?;
        crate::logutil::write_line("global shortcut Control+H registered");
    }
    #[cfg(windows)]
    start_chord_watch(app.handle().clone());
    Ok(())
}

/// Window create/show must run on the UI thread. Chord/hotkey callbacks do not.
fn schedule_toggle(app: &AppHandle, reason: &str) {
    crate::logutil::write_line(&format!("schedule_toggle ({reason})"));
    let app = app.clone();
    let reason = reason.to_string();
    if let Err(err) = app.clone().run_on_main_thread(move || {
        crate::logutil::write_line(&format!("toggle on main ({reason})"));
        match toggle_frontend(app) {
            Ok(open) => crate::logutil::write_line(&format!("toggle_frontend done -> {open}")),
            Err(err) => crate::logutil::write_line(&format!("toggle_frontend error: {err}")),
        }
    }) {
        crate::logutil::write_line(&format!("run_on_main_thread failed: {err}"));
    }
}

fn create(app: &AppHandle) -> Result<(), String> {
    let title = pick("前端", "Frontend");
    crate::logutil::write_line("frontend create begin");
    // Do not put shell=? or #fragment on WebviewUrl::App — packaged WebView2 can hang or drop them.
    // Mark the shell with an init script before the page bundle runs.
    let window = WebviewWindowBuilder::new(app, FRONTEND_LABEL, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(FRONTEND_WIDTH, 800.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .visible(false)
        .initialization_script(
            r#"
            window.__FANTASYHUB_FRONTEND__ = true;
            try { sessionStorage.setItem("fantasyhub-shell", "frontend"); } catch (e) {}
            "#,
        )
        .build()
        .map_err(|err| {
            let msg = pick(
                &format!("无法打开前端：{err}"),
                &format!("Couldn't open frontend: {err}"),
            );
            crate::logutil::write_line(&msg);
            msg
        })?;
    crate::logutil::write_line("frontend window built");
    place(&window, app);
    crate::logutil::write_line("frontend window placed");
    attach(&window, app);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.set_always_on_top(true);
    emit_state(app, true);
    crate::logutil::write_line("frontend window opened");
    Ok(())
}

fn attach(window: &WebviewWindow, app: &AppHandle) {
    let app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed | WindowEvent::CloseRequested { .. }) {
            emit_state(&app, false);
            focus_main_if_idle(&app);
        }
    });
}

fn dismiss(app: &AppHandle, window: &WebviewWindow) {
    let _ = window.hide();
    let _ = window.destroy();
    emit_state(app, false);
    focus_main_if_idle(app);
}

fn focus_main_if_idle(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let minimized = main.is_minimized().unwrap_or(false);
    let visible = main.is_visible().unwrap_or(false);
    if visible && !minimized {
        let _ = main.set_focus();
    }
}

fn emit_state(app: &AppHandle, open: bool) {
    let _ = app.emit("frontend-state", open);
}

fn window_focused(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

fn place(window: &WebviewWindow, app: &AppHandle) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| {
            app.get_webview_window("main")
                .and_then(|main| main.current_monitor().ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        crate::logutil::write_line("frontend place: no monitor");
        return;
    };
    let screen = monitor.size();
    let origin = monitor.position();
    let scale = monitor.scale_factor();
    let width = ((FRONTEND_WIDTH * scale).round() as u32)
        .max(320)
        .min(screen.width);
    let height = screen.height;
    let x = origin.x + screen.width.saturating_sub(width) as i32;
    let y = origin.y;
    crate::logutil::write_line(&format!(
        "frontend place x={x} y={y} w={width} h={height} scale={scale}"
    ));
    let _ = window.set_size(tauri::Size::Physical(PhysicalSize { width, height }));
    let _ = window.set_position(tauri::Position::Physical(PhysicalPosition { x, y }));
}

#[cfg(windows)]
fn start_chord_watch(app: AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    static CHORD_WATCHING: AtomicBool = AtomicBool::new(false);
    if CHORD_WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::logutil::write_line("chord watch started");
    std::thread::spawn(move || {
        use windows_sys::Win32::UI::Input::XboxController::{
            XInputGetState, XINPUT_GAMEPAD_BACK, XINPUT_GAMEPAD_START, XINPUT_STATE,
        };

        let mut held = false;
        loop {
            if crate::startup::quit_allowed() {
                CHORD_WATCHING.store(false, Ordering::SeqCst);
                break;
            }
            let mut pressed = false;
            for index in 0..4u32 {
                let mut state = unsafe { std::mem::zeroed::<XINPUT_STATE>() };
                let ok = unsafe { XInputGetState(index, &mut state) };
                if ok != 0 {
                    continue;
                }
                let buttons = state.Gamepad.wButtons;
                let back = buttons & XINPUT_GAMEPAD_BACK != 0;
                let start = buttons & XINPUT_GAMEPAD_START != 0;
                if back && start {
                    pressed = true;
                    break;
                }
            }
            if pressed && !held {
                let focused = software_focused(&app);
                if focused {
                    // In-app Start is handled by the frontend gamepad hook.
                    crate::logutil::write_line("chord Back+Start ignored (app focused)");
                } else {
                    crate::logutil::write_line("chord Back+Start");
                    schedule_toggle(&app, "chord Back+Start");
                }
            }
            held = pressed;
            std::thread::sleep(Duration::from_millis(40));
        }
    });
}
