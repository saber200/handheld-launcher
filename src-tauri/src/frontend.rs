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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendStateEvent {
    open: bool,
    /// "inline" = in-app drawer on main; "float" = always-on-top overlay window.
    surface: &'static str,
}

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
    // Main shell owns the in-app drawer via JS. Float only when FantasyHub is not foreground.
    // A *visible* overlay always wins though: if it is on screen the user is
    // asking to dismiss it, whatever the focus says (SetForegroundWindow can
    // fail, which used to leave the overlay stuck with no way out).
    if FRONTEND_OPEN.load(Ordering::SeqCst) {
        crate::logutil::write_line("toggle_frontend close (overlay visible)");
        schedule_set_open(app, false, "toggle_frontend");
        return Ok(false);
    }
    if shell_is_foreground(&app) {
        crate::logutil::write_line("toggle_frontend ignored (main owns drawer)");
        return Ok(false);
    }
    crate::logutil::write_line("toggle_frontend float -> true");
    schedule_set_open(app, true, "toggle_frontend");
    Ok(true)
}

#[tauri::command]
pub async fn open_frontend(app: tauri::AppHandle) -> Result<(), String> {
    if shell_is_foreground(&app) {
        crate::logutil::write_line("open_frontend inline (main foreground)");
        // Never open the second WebView over FSE home — it ducks fullscreen and freezes.
        FRONTEND_OPEN.store(false, Ordering::SeqCst);
        // The drawer replaces the overlay: take a leftover overlay window off
        // screen, otherwise it is visible but unknown to FRONTEND_OPEN (so no
        // pad events, no toggle) and can never be closed again.
        hide(&app);
        emit_state(&app, true, "inline");
        return Ok(());
    }
    if FRONTEND_OPEN.load(Ordering::SeqCst) {
        crate::logutil::write_line("open_frontend (already open)");
        schedule_focus(app);
        return Ok(());
    }
    crate::logutil::write_line("open_frontend float schedule");
    schedule_set_open(app, true, "open_frontend");
    Ok(())
}

#[tauri::command]
pub async fn close_frontend(app: tauri::AppHandle) -> Result<(), String> {
    crate::logutil::write_line("close_frontend");
    if FRONTEND_OPEN.load(Ordering::SeqCst) {
        schedule_set_open(app, false, "close_frontend");
    } else {
        emit_state(&app, false, "none");
    }
    Ok(())
}

#[tauri::command]
pub fn focus_frontend(app: tauri::AppHandle) -> Result<(), String> {
    schedule_focus(app);
    Ok(())
}

/// Hide the floating overlay — the library shell is taking over again.
pub fn hide_overlay(app: &AppHandle) {
    if FRONTEND_OPEN.load(Ordering::SeqCst) {
        schedule_set_open(app.clone(), false, "reveal launcher");
    }
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
                        // Outside main, toggle the floating overlay — and always
                        // allow closing a visible overlay.
                        if FRONTEND_OPEN.load(Ordering::SeqCst) {
                            schedule_set_open(app.clone(), false, "hotkey Control+H");
                            return;
                        }
                        if shell_is_foreground(app) {
                            return;
                        }
                        schedule_set_open(app.clone(), true, "hotkey Control+H");
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
        match set_open_direct(&app, open) {
            Ok(()) => {
                crate::logutil::write_line(&format!("frontend set_open ok ({reason}) open={open}"))
            }
            Err(err) => {
                if open {
                    FRONTEND_OPEN.store(false, Ordering::SeqCst);
                    emit_state(&app, false, "none");
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
            {
                detach_owner(&window);
                force_topmost(&window);
                steal_foreground(&window);
                force_topmost(&window);
            }
            let _ = window.set_focus();
        }
    });
}

fn emit_state(app: &AppHandle, open: bool, surface: &'static str) {
    let _ = app.emit(
        "frontend-state",
        FrontendStateEvent { open, surface },
    );
}

fn set_open_direct(app: &AppHandle, open: bool) -> Result<(), String> {
    if open {
        FRONTEND_OPEN.store(true, Ordering::SeqCst);
        ensure_created(app)?;
        show(app)?;
        emit_state(app, true, "float");
    } else {
        hide(app);
        FRONTEND_OPEN.store(false, Ordering::SeqCst);
        emit_state(app, false, "none");
    }
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
    #[cfg(windows)]
    {
        detach_owner(&window);
        force_topmost(&window);
    }
    let _ = window.hide();
    crate::logutil::write_line("frontend window built (hidden)");
    Ok(())
}

fn show(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(FRONTEND_LABEL) else {
        return Err(pick("前端窗口还没准备好", "Frontend window is not ready yet."));
    };
    // Game Bar style: never hide/minimize main. Float as an unowned TOPMOST overlay.
    crate::logutil::write_line("frontend show: place");
    place(&window, app);
    #[cfg(windows)]
    {
        detach_owner(&window);
        force_topmost(&window);
    }
    crate::logutil::write_line("frontend show: show()");
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    #[cfg(windows)]
    {
        detach_owner(&window);
        force_topmost(&window);
        steal_foreground(&window);
        force_topmost(&window);
    }
    let _ = window.set_focus();
    FRONTEND_OPEN.store(true, Ordering::SeqCst);
    crate::logutil::write_line("frontend shown");
    Ok(())
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
        let _ = window.hide();
        crate::logutil::write_line("frontend hidden");
    }
    // Do not steal focus back to main — that covers the game after Back+Start close.
    // Only reclaim when the launcher is already the interactive surface.
    focus_main_if_idle(app);
}

/// Clear GW_OWNER so the overlay is not tied to main (owned popups cannot float like Game Bar).
#[cfg(windows)]
fn detach_owner(window: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, SetWindowLongPtrW, GA_ROOT, GWLP_HWNDPARENT,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let mut hwnd = hwnd.0 as _;
        let root = GetAncestor(hwnd, GA_ROOT);
        if !root.is_null() {
            hwnd = root;
        }
        SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
    }
}

#[cfg(windows)]
fn force_topmost(window: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetWindowLongW, SetWindowLongW, SetWindowPos, GA_ROOT, GWL_EXSTYLE,
        HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let mut hwnd = hwnd.0 as _;
        let root = GetAncestor(hwnd, GA_ROOT);
        if !root.is_null() {
            hwnd = root;
        }
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(
            hwnd,
            GWL_EXSTYLE,
            ex | WS_EX_TOPMOST as i32 | WS_EX_TOOLWINDOW as i32,
        );
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
    }
}

#[cfg(windows)]
fn steal_foreground(window: &WebviewWindow) {
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, SetActiveWindow, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, BringWindowToTop, GetAncestor, GetForegroundWindow,
        GetWindowThreadProcessId, SetForegroundWindow, ASFW_ANY, GA_ROOT,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        let mut hwnd = hwnd.0 as _;
        let root = GetAncestor(hwnd, GA_ROOT);
        if !root.is_null() {
            hwnd = root;
        }
        AllowSetForegroundWindow(ASFW_ANY);
        keybd_event(VK_MENU as u8, 0, 0, 0);
        keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
        let foreground = GetForegroundWindow();
        let foreground_thread = GetWindowThreadProcessId(foreground, std::ptr::null_mut());
        let target_thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
        let current = GetCurrentThreadId();
        let attach_fg = foreground_thread != 0
            && foreground_thread != current
            && AttachThreadInput(current, foreground_thread, 1) != 0;
        let attach_tg = target_thread != 0
            && target_thread != current
            && target_thread != foreground_thread
            && AttachThreadInput(current, target_thread, 1) != 0;
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        SetActiveWindow(hwnd);
        if attach_tg {
            AttachThreadInput(current, target_thread, 0);
        }
        if attach_fg {
            AttachThreadInput(current, foreground_thread, 0);
        }
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
                emit_state(&app, false, "none");
                focus_main_if_idle(&app);
            }
            WindowEvent::Destroyed => {
                FRONTEND_OPEN.store(false, Ordering::SeqCst);
                PRELOAD_STARTED.store(false, Ordering::SeqCst);
                emit_state(&app, false, "none");
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

/// True when the library shell (not the float overlay) owns the foreground.
fn shell_is_foreground(app: &AppHandle) -> bool {
    // Prefer Tauri focus — reliable while the user is in the library UI.
    if window_focused(app, "main") {
        return true;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetAncestor, GetForegroundWindow, IsChild, GA_ROOT,
        };
        let Some(main) = app.get_webview_window("main") else {
            return false;
        };
        if !main.is_visible().unwrap_or(false) || main.is_minimized().unwrap_or(false) {
            return false;
        }
        let Ok(main_raw) = main.hwnd() else {
            return false;
        };
        unsafe {
            let fg = GetForegroundWindow();
            if fg.is_null() {
                return false;
            }
            // Float overlay owns input — not the shell drawer.
            if let Some(front) = app.get_webview_window(FRONTEND_LABEL) {
                if let Ok(front_raw) = front.hwnd() {
                    let mut front_hwnd = front_raw.0 as _;
                    let root = GetAncestor(front_hwnd, GA_ROOT);
                    if !root.is_null() {
                        front_hwnd = root;
                    }
                    if fg == front_hwnd || IsChild(front_hwnd, fg) != 0 {
                        return false;
                    }
                }
            }
            let mut main_hwnd = main_raw.0 as _;
            let root = GetAncestor(main_hwnd, GA_ROOT);
            if !root.is_null() {
                main_hwnd = root;
            }
            fg == main_hwnd || IsChild(main_hwnd, fg) != 0
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn window_focused(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

fn place(window: &WebviewWindow, app: &AppHandle) {
    // Prefer the main window's monitor when it is visible. Asking a hidden window
    // for current_monitor() has hung under FSE home / exclusive fullscreen.
    let monitor = app
        .get_webview_window("main")
        .filter(|main| main.is_visible().unwrap_or(false))
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
                // Only ignore the *open* while the library shell is foreground
                // (Start opens the in-app drawer there). A visible overlay is
                // always closable, even if the focus check thinks main owns it.
                if FRONTEND_OPEN.load(Ordering::SeqCst) {
                    crate::logutil::write_line("chord Back+Start closes visible overlay");
                    schedule_set_open(app.clone(), false, "chord Back+Start");
                } else if shell_is_foreground(&app) {
                    crate::logutil::write_line("chord Back+Start ignored (main foreground)");
                } else {
                    crate::logutil::write_line("chord Back+Start");
                    schedule_set_open(app.clone(), true, "chord Back+Start");
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
