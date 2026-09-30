//! 浮层的显示/隐藏与定位。
//!
//! 这里**只关心自己的窗口**：没有「启动器是否在前台」这种跨程序状态，
//! 所以不会出现 0.1.45 那种「窗口在屏上、状态却是关的、于是关不掉」的组合。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const WINDOW_LABEL: &str = "main";

/// 贴右浮层的逻辑宽度，乘缩放系数得物理宽度，与启动器原来的浮层保持一致。
const WIDTH_LOGICAL: f64 = 440.0;

/// 打开时是否抢焦点：抢了键盘/方向键才能用，不抢就只有手柄能操作（FRONTEND.md §3）。
/// 阶段 3/4 接上共享设置文件后改成可配置项。
const TAKE_FOCUS: bool = true;

static VISIBLE: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

pub fn is_visible() -> bool {
    VISIBLE.load(Ordering::SeqCst)
}

/// 托盘点了退出：让手柄轮询线程自己收工。
pub fn request_quit() {
    QUITTING.store(true, Ordering::SeqCst);
}

pub fn toggle(app: &AppHandle, reason: &str) {
    if is_visible() {
        hide(app, reason);
    } else {
        show(app, reason);
    }
}

pub fn show(app: &AppHandle, reason: &str) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        fh_core::logutil::write_line(&format!("frontend show failed: no window ({reason})"));
        return;
    };
    fh_core::logutil::write_line(&format!("frontend show begin ({reason})"));
    place(&window, app);
    let _ = window.set_always_on_top(true);
    let _ = window.show();
    if TAKE_FOCUS {
        let _ = window.set_focus();
    }
    VISIBLE.store(true, Ordering::SeqCst);
    fh_core::logutil::write_line("frontend shown");
}

pub fn hide(app: &AppHandle, reason: &str) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
    VISIBLE.store(false, Ordering::SeqCst);
    fh_core::logutil::write_line(&format!("frontend hidden ({reason})"));
}

/// 贴右、置顶、整屏高。
///
/// 定位先问主显示器、再问窗口自己：对一个还隐藏着的窗口调 `current_monitor()`
/// 在独占全屏下会卡住（启动器里踩过这个坑），所以后者只当兜底。
fn place(window: &WebviewWindow, app: &AppHandle) {
    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        fh_core::logutil::write_line("frontend place: no monitor");
        return;
    };
    let screen = monitor.size();
    let origin = monitor.position();
    let scale = monitor.scale_factor();
    let width = ((WIDTH_LOGICAL * scale).round() as u32)
        .max(320)
        .min(screen.width);
    let height = screen.height;
    let x = origin.x + screen.width.saturating_sub(width) as i32;
    let y = origin.y;
    fh_core::logutil::write_line(&format!(
        "frontend place x={x} y={y} w={width} h={height} scale={scale}"
    ));
    let _ = window.set_size(tauri::Size::Physical(PhysicalSize { width, height }));
    let _ = window.set_position(tauri::Position::Physical(PhysicalPosition { x, y }));
}

/// 关窗永远只是隐藏：前端是托盘常驻软件，真正退出只能走托盘菜单。
pub fn attach_window_events(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            hide(&handle, "close requested");
        }
    });
}
