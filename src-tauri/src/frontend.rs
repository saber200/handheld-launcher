use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};

static FRONTEND_OPEN: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn toggle_frontend(app: tauri::AppHandle) -> Result<bool, String> {
    let next = !FRONTEND_OPEN.load(Ordering::SeqCst);
    crate::logutil::write_line(&format!("toggle_frontend -> {next}"));
    set_open(&app, next);
    Ok(next)
}

#[tauri::command]
pub fn close_frontend(app: tauri::AppHandle) -> Result<(), String> {
    crate::logutil::write_line("close_frontend");
    set_open(&app, false);
    Ok(())
}

#[tauri::command]
pub fn focus_frontend(app: tauri::AppHandle) -> Result<(), String> {
    // Frontend is an in-app panel on the main window now.
    reveal_main(&app);
    Ok(())
}

pub fn frontend_visible(_app: &AppHandle) -> bool {
    FRONTEND_OPEN.load(Ordering::SeqCst)
}

/// True when FantasyHub itself currently has keyboard focus.
pub fn software_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
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

fn set_open(app: &AppHandle, open: bool) {
    FRONTEND_OPEN.store(open, Ordering::SeqCst);
    if open {
        reveal_main(app);
    }
    let _ = app.emit("frontend-state", open);
}

fn reveal_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        crate::logutil::write_line("reveal_main: no main window");
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_fullscreen(true);
    let _ = window.set_focus();
    crate::logutil::write_line("reveal_main ok");
}

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

#[cfg(windows)]
fn start_chord_watch(app: AppHandle) {
    use std::sync::atomic::AtomicBool as Flag;
    use std::time::Duration;

    static CHORD_WATCHING: Flag = Flag::new(false);
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
