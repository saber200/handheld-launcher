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

/// 手柄轮询每 40 ms 问一次，走这个便宜的静态判断；
/// **决定**开还是关请用 `toggle`，它问的是窗口本身（见下）。
pub fn is_visible() -> bool {
    VISIBLE.load(Ordering::SeqCst)
}

/// 真相只有一个：窗口自己的 `is_visible()`。静态的 `VISIBLE` 只是缓存。
fn window_visible(app: &AppHandle) -> Option<bool> {
    app.get_webview_window(WINDOW_LABEL)?.is_visible().ok()
}

/// 托盘点了退出：让手柄轮询线程自己收工。
pub fn request_quit() {
    QUITTING.store(true, Ordering::SeqCst);
}

pub fn toggle(app: &AppHandle, reason: &str) {
    // 这里曾经只看静态标记，于是「按了没反应」有了一个隐蔽的来源：只要有一次
    // show() 没真把窗口显示出来，标记就已经变成 true，之后每次按键都在做 hide()。
    // 现在每次都问窗口：它说在屏上才关，否则开。
    let visible = window_visible(app).unwrap_or_else(is_visible);
    if visible {
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
    // 把窗口**实际加载的页面**记下来：0.1.46 的前端窗口因为配置里没写 `url`，
    // 生产包里加载的是 index.html（启动器那一页）—— 一行日志就能看穿。
    let url = window
        .url()
        .map(|u| u.to_string())
        .unwrap_or_else(|_| "?".into());
    fh_core::logutil::write_line(&format!("frontend show begin ({reason}) url={url}"));
    place(&window, app);
    if let Err(err) = window.set_always_on_top(true) {
        fh_core::logutil::write_line(&format!("frontend always-on-top failed: {err}"));
    }
    // 以前这里的返回值被吞了：窗口没出来，日志却照样写着 "frontend shown"，
    // 现场只剩「按了没反应」。现在失败要留话，成功也要把真实可见性写回来。
    if let Err(err) = window.show() {
        fh_core::logutil::write_line(&format!("frontend show failed ({reason}): {err}"));
    }
    if TAKE_FOCUS {
        if let Err(err) = window.set_focus() {
            fh_core::logutil::write_line(&format!("frontend focus failed: {err}"));
        }
    }
    let visible = window_visible(app).unwrap_or(true);
    VISIBLE.store(visible, Ordering::SeqCst);
    fh_core::logutil::write_line(&format!("frontend show end ({reason}) is_visible={visible}"));
    if !visible {
        // 说了要显示却还是不可见：把窗口的真实位置/尺寸记下来，否则现场只剩一句「没反应」。
        let pos = window
            .outer_position()
            .map(|p| format!("{},{}", p.x, p.y))
            .unwrap_or_else(|_| "?".into());
        let size = window
            .outer_size()
            .map(|s| format!("{}x{}", s.width, s.height))
            .unwrap_or_else(|_| "?".into());
        fh_core::logutil::write_line(&format!("frontend still hidden: pos={pos} size={size}"));
    }
}

pub fn hide(app: &AppHandle, reason: &str) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if let Err(err) = window.hide() {
            fh_core::logutil::write_line(&format!("frontend hide failed: {err}"));
        }
    }
    let visible = window_visible(app).unwrap_or(false);
    VISIBLE.store(visible, Ordering::SeqCst);
    fh_core::logutil::write_line(&format!("frontend hide end ({reason}) is_visible={visible}"));
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
