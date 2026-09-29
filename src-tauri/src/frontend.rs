use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::i18n::pick;

const FRONTEND_LABEL: &str = "frontend";
const FRONTEND_WIDTH: f64 = 440.0;

static FRONTEND_OPEN: AtomicBool = AtomicBool::new(false);
static PRELOAD_STARTED: AtomicBool = AtomicBool::new(false);
/// Main left exclusive fullscreen so the floating overlay can paint above it.
static DUCKED_MAIN: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Serialize)]
struct FrontendPad {
    dx: i8,
    dy: i8,
    a: bool,
    b: bool,
    start: bool,
}

/// Create the floating frontend window once at startup (hidden).
/// Windows WebView2 deadlocks if we `build()` inside a sync IPC command.
pub fn preload(app: &AppHandle) {
    if app.get_webview_window(FRONTEND_LABEL).is_some() {
        return;
    }
    if PRELOAD_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        crate::logutil::write_line("frontend preload begin");
        match create_hidden(&app) {
            Ok(()) => crate::logutil::write_line("frontend preload ok"),
            Err(err) => {
                PRELOAD_STARTED.store(false, Ordering::SeqCst);
                crate::logutil::write_line(&format!("frontend preload failed: {err}"));
            }
        }
    });
}

#[tauri::command]
pub async fn toggle_frontend(app: tauri::AppHandle) -> Result<bool, String> {
    let next = !FRONTEND_OPEN.load(Ordering::SeqCst);
    crate::logutil::write_line(&format!("toggle_frontend schedule -> {next}"));
    // Always the independent always-on-top WebView so it can cover other apps.
    schedule_set_open(app, next, "toggle_frontend");
    Ok(next)
}

#[tauri::command]
pub async fn open_frontend(app: tauri::AppHandle) -> Result<(), String> {
    if FRONTEND_OPEN.load(Ordering::SeqCst) {
        crate::logutil::write_line("open_frontend (already open)");
        schedule_focus(app);
        return Ok(());
    }
    crate::logutil::write_line("open_frontend schedule");
    schedule_set_open(app, true, "open_frontend");
    Ok(())
}

#[tauri::command]
pub async fn close_frontend(app: tauri::AppHandle) -> Result<(), String> {
    crate::logutil::write_line("close_frontend schedule");
    schedule_set_open(app, false, "close_frontend");
    Ok(())
}

#[tauri::command]
pub fn focus_frontend(app: tauri::AppHandle) -> Result<(), String> {
    schedule_focus(app);
    Ok(())
}

pub fn frontend_visible(_app: &AppHandle) -> bool {
    FRONTEND_OPEN.load(Ordering::SeqCst)
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
                        // Main shell already toggles the in-app drawer on Ctrl+H.
                        // Outside main, toggle the floating overlay.
                        if window_focused(app, "main") {
                            return;
                        }
                        schedule_set_open(
                            app.clone(),
                            !FRONTEND_OPEN.load(Ordering::SeqCst),
                            "hotkey Control+H",
                        );
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

fn schedule_set_open(app: AppHandle, open: bool, reason: &str) {
    let reason = reason.to_string();
    std::thread::spawn(move || {
        crate::logutil::write_line(&format!("frontend set_open begin ({reason}) open={open}"));
        // Run off the IPC/async worker and do NOT block the UI thread waiting.
        // If show() stalls under FSE, the main window must stay responsive.
        match set_open_direct(&app, open) {
            Ok(()) => {
                crate::logutil::write_line(&format!("frontend set_open ok ({reason}) open={open}"))
            }
            Err(err) => {
                if open {
                    FRONTEND_OPEN.store(false, Ordering::SeqCst);
                    let _ = app.emit("frontend-state", false);
                }
                crate::logutil::write_line(&format!("frontend set_open err ({reason}): {err}"));
            }
        }
    });
}

fn schedule_focus(app: AppHandle) {
    let _ = app.clone().run_on_main_thread(move || {
        let Some(window) = app.get_webview_window(FRONTEND_LABEL) else {
            return;
        };
        if FRONTEND_OPEN.load(Ordering::SeqCst) {
            let _ = window.set_always_on_top(true);
            #[cfg(windows)]
            force_topmost(&window);
            let _ = window.set_focus();
        }
    });
}

fn set_open_direct(app: &AppHandle, open: bool) -> Result<(), String> {
    if open {
        FRONTEND_OPEN.store(true, Ordering::SeqCst);
        ensure_created(app)?;
        show(app)?;
    } else {
        hide(app);
        FRONTEND_OPEN.store(false, Ordering::SeqCst);
    }
    let _ = app.emit("frontend-state", open);
    Ok(())
}

fn ensure_created(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(FRONTEND_LABEL).is_some() {
        return Ok(());
    }
    crate::logutil::write_line("frontend ensure_created");
    create_hidden(app)
}

fn create_hidden(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(FRONTEND_LABEL).is_some() {
        return Ok(());
    }
    let title = pick("前端", "Frontend");
    let window = WebviewWindowBuilder::new(app, FRONTEND_LABEL, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(FRONTEND_WIDTH, 800.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .initialization_script(
            r#"
            window.__FANTASYHUB_FRONTEND__ = true;
            try { sessionStorage.setItem("fantasyhub-shell", "frontend"); } catch (e) {}
            "#,
        )
        .build()
        .map_err(|err| {
            pick(
                &format!("无法打开前端：{err}"),
                &format!("Couldn't open frontend: {err}"),
            )
        })?;
    place(&window, app);
    attach(&window, app);
    let _ = window.hide();
    crate::logutil::write_line("frontend window built (hidden)");
    Ok(())
}

fn show(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(FRONTEND_LABEL) else {
        return Err(pick("前端窗口还没准备好", "Frontend window is not ready yet."));
    };
    // Exclusive fullscreen on main covers sibling windows even with always_on_top.
    duck_main_for_overlay(app);
    crate::logutil::write_line("frontend show: place");
    place(&window, app);
    crate::logutil::write_line("frontend show: show()");
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    #[cfg(windows)]
    force_topmost(&window);
    let _ = window.set_focus();
    let _ = window.emit("frontend-state", true);
    FRONTEND_OPEN.store(true, Ordering::SeqCst);
    crate::logutil::write_line("frontend shown");
    Ok(())
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
        let _ = window.hide();
        let _ = window.emit("frontend-state", false);
        crate::logutil::write_line("frontend hidden");
    }
    restore_ducked_main(app);
    focus_main_if_idle(app);
}

/// Leave main exclusive fullscreen so a second topmost window can appear above it.
fn duck_main_for_overlay(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if main.is_minimized().unwrap_or(false) {
        return;
    }
    if !main.is_fullscreen().unwrap_or(false) {
        return;
    }
    let _ = main.set_fullscreen(false);
    DUCKED_MAIN.store(true, Ordering::SeqCst);
    crate::logutil::write_line("frontend: ducked main fullscreen for overlay");
}

fn restore_ducked_main(app: &AppHandle) {
    if !DUCKED_MAIN.swap(false, Ordering::SeqCst) {
        return;
    }
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if main.is_minimized().unwrap_or(false) || !main.is_visible().unwrap_or(false) {
        return;
    }
    crate::logutil::write_line("frontend: restore main fullscreen after overlay");
    crate::startup::fill_screen(&main);
}

#[cfg(windows)]
fn force_topmost(window: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        SetWindowPos(
            hwnd.0 as _,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
    }
}

fn attach(window: &WebviewWindow, app: &AppHandle) {
    let app = app.clone();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                FRONTEND_OPEN.store(false, Ordering::SeqCst);
                if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
                    let _ = window.hide();
                }
                let _ = app.emit("frontend-state", false);
                focus_main_if_idle(&app);
            }
            WindowEvent::Destroyed => {
                FRONTEND_OPEN.store(false, Ordering::SeqCst);
                PRELOAD_STARTED.store(false, Ordering::SeqCst);
                let _ = app.emit("frontend-state", false);
                focus_main_if_idle(&app);
            }
            _ => {}
        }
    });
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

fn window_focused(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

fn place(window: &WebviewWindow, app: &AppHandle) {
    // Prefer the main window's monitor. Asking a hidden frontend window for
    // current_monitor() has hung under FSE home / exclusive fullscreen.
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
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
    use std::time::Duration;

    static CHORD_WATCHING: AtomicBool = AtomicBool::new(false);
    if CHORD_WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::logutil::write_line("chord watch started");
    std::thread::spawn(move || {
        use windows_sys::Win32::UI::Input::XboxController::{
            XInputGetState, XINPUT_GAMEPAD_A, XINPUT_GAMEPAD_B, XINPUT_GAMEPAD_BACK,
            XINPUT_GAMEPAD_DPAD_DOWN, XINPUT_GAMEPAD_DPAD_LEFT, XINPUT_GAMEPAD_DPAD_RIGHT,
            XINPUT_GAMEPAD_DPAD_UP, XINPUT_GAMEPAD_START, XINPUT_STATE,
        };

        let mut held = false;
        loop {
            if crate::startup::quit_allowed() {
                CHORD_WATCHING.store(false, Ordering::SeqCst);
                break;
            }
            let mut pressed = false;
            let mut pad = FrontendPad {
                dx: 0,
                dy: 0,
                a: false,
                b: false,
                start: false,
            };
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
                }
                if FRONTEND_OPEN.load(Ordering::SeqCst) {
                    let lx = state.Gamepad.sThumbLX as i32;
                    let ly = state.Gamepad.sThumbLY as i32;
                    let dead = 16000;
                    let mut dx = 0i8;
                    let mut dy = 0i8;
                    if buttons & XINPUT_GAMEPAD_DPAD_LEFT != 0 || lx < -dead {
                        dx = -1;
                    } else if buttons & XINPUT_GAMEPAD_DPAD_RIGHT != 0 || lx > dead {
                        dx = 1;
                    }
                    if buttons & XINPUT_GAMEPAD_DPAD_UP != 0 || ly > dead {
                        dy = -1;
                    } else if buttons & XINPUT_GAMEPAD_DPAD_DOWN != 0 || ly < -dead {
                        dy = 1;
                    }
                    pad = FrontendPad {
                        dx,
                        dy,
                        a: buttons & XINPUT_GAMEPAD_A != 0,
                        b: buttons & XINPUT_GAMEPAD_B != 0,
                        start,
                    };
                    break;
                }
                if pressed {
                    break;
                }
            }
            if pressed && !held {
                // Only ignore while the library shell is focused (Start opens the
                // in-app drawer there). When a game is up — or the floating
                // frontend itself is focused — Back+Start toggles the overlay.
                if window_focused(&app, "main") {
                    crate::logutil::write_line("chord Back+Start ignored (main focused)");
                } else {
                    crate::logutil::write_line("chord Back+Start");
                    schedule_set_open(
                        app.clone(),
                        !FRONTEND_OPEN.load(Ordering::SeqCst),
                        "chord Back+Start",
                    );
                }
            }
            held = pressed;

            if FRONTEND_OPEN.load(Ordering::SeqCst) {
                if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
                    let _ = window.emit("frontend-pad", pad);
                }
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    });
}
