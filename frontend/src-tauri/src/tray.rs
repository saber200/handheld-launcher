//! 无窗口托盘：只提示官方 Game Bar 入口，不模拟激活。
use std::sync::{atomic::{AtomicBool, AtomicI8, Ordering}, mpsc, Mutex, OnceLock};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};
use crate::text;

static BACKGROUND_BUSY: AtomicBool = AtomicBool::new(false);
static QUIT_BUSY: AtomicBool = AtomicBool::new(false);
static AUTOSTART_QUEUE: OnceLock<mpsc::SyncSender<(AppHandle, bool)>> = OnceLock::new();
static AUTOSTART_LOCK: Mutex<()> = Mutex::new(());

pub struct TrayItems {
    autostart: CheckMenuItem<Wry>,
    hint: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    state: AtomicI8,
    retry: AtomicI8,
    quit_failed: AtomicBool,
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let hint = MenuItem::with_id(app, "hint", text::gamebar_hint(), false, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", text::autostart_label(false, false), true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", text::quit(), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&hint, &autostart, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut builder = TrayIconBuilder::with_id("backend")
        .tooltip(text::tooltip()).menu(&menu).show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "autostart" => background(app, |app| {
                let retry = app.try_state::<TrayItems>().map(|i| i.retry.load(Ordering::Relaxed)).unwrap_or(-1);
                let target = match retry {
                    0 => Some(false), 1 => Some(true),
                    _ => autostart_enabled(&app).ok().map(|v| !v),
                };
                if let Some(target) = target { let _ = set_autostart(&app, target); }
                else { update_state(&app, None); }
            }),
            "quit" => background_with(&QUIT_BUSY, app, |app| {
                if fh_core::autostart::mark_stopped().is_ok() {
                    crate::request_exit(&app);
                } else if let Some(items) = app.try_state::<TrayItems>() {
                    items.quit_failed.store(true, Ordering::Relaxed);
                    refresh(&app);
                }
            }),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() { builder = builder.icon(icon); }
    builder.build(app)?;
    app.manage(TrayItems { autostart, hint, quit, state: AtomicI8::new(-1), retry: AtomicI8::new(-1), quit_failed: AtomicBool::new(false) });
    background(app, |app| { update_state(&app, autostart_enabled(&app).ok()); });
    Ok(())
}

fn background(app: &AppHandle, work: impl FnOnce(AppHandle) + Send + 'static) {
    background_with(&BACKGROUND_BUSY, app, work);
}

fn background_with(busy: &'static AtomicBool, app: &AppHandle, work: impl FnOnce(AppHandle) + Send + 'static) {
    if busy.swap(true, Ordering::AcqRel) { return; }
    let app = app.clone();
    let result = std::thread::Builder::new().spawn(move || {
        struct Reset(&'static AtomicBool);
        impl Drop for Reset { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }
        let _reset = Reset(busy);
        work(app);
    });
    if result.is_err() { busy.store(false, Ordering::Release); }
}

pub fn set_autostart_background(app: &AppHandle, enabled: bool) {
    // 专用有界队列不受首次查询或托盘退出影响；满队列明确记录失败。
    let queue = AUTOSTART_QUEUE.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<(AppHandle, bool)>(8);
        std::thread::spawn(move || {
            for (app, enabled) in rx {
                if let Err(err) = set_autostart(&app, enabled) {
                    fh_core::logutil::write_line(&format!("autostart argument failed: {err}"));
                }
            }
        });
        tx
    });
    if queue.try_send((app.clone(), enabled)).is_err() {
        fh_core::logutil::write_line("autostart argument queue unavailable");
        if let Some(items) = app.try_state::<TrayItems>() {
            items.retry.store(i8::from(enabled), Ordering::Relaxed);
        }
        update_state(app, None);
    }
}

pub fn refresh(app: &AppHandle) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let state = items.state.load(Ordering::Relaxed);
        let _ = items.autostart.set_checked(state == 1);
        let _ = items.autostart.set_text(text::autostart_label(state != -1, items.retry.load(Ordering::Relaxed) != -1));
        let _ = items.hint.set_text(text::gamebar_hint());
        let _ = items.quit.set_text(if items.quit_failed.load(Ordering::Relaxed) { text::quit_failed() } else { text::quit() });
    }
    if let Some(tray) = app.tray_by_id("backend") { let _ = tray.set_tooltip(Some(text::tooltip())); }
}

fn update_state(app: &AppHandle, state: Option<bool>) {
    if let Some(items) = app.try_state::<TrayItems>() {
        items.state.store(state.map(i8::from).unwrap_or(-1), Ordering::Relaxed);
    }
    refresh(app);
}

pub fn autostart_enabled(app: &AppHandle) -> Result<bool, String> {
    #[cfg(windows)]
    match fh_core::autostart::task_state()? {
        fh_core::autostart::TaskState::Enabled => return Ok(true),
        fh_core::autostart::TaskState::Disabled => return Ok(false),
        fh_core::autostart::TaskState::Missing => {}
    }
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|err| format!("Autostart query failed: {err}"))
}

/// 计划任务优先，缺失时才使用 Run 兜底；IPC 永不弹阻塞对话框。
pub fn set_autostart(app: &AppHandle, on: bool) -> Result<bool, String> {
    let _guard = AUTOSTART_LOCK.try_lock().map_err(|_| "Autostart operation is still running".to_string())?;
    let result = (|| -> Result<bool, String> {
        #[cfg(windows)]
        match fh_core::autostart::task_state()? {
            fh_core::autostart::TaskState::Enabled | fh_core::autostart::TaskState::Disabled => {
                fh_core::autostart::set_task_enabled(on)?;
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
            .map_err(|err| format!("Autostart update failed: {err}"))?;
        fh_core::autostart::set_autostart_switch(on)?;
        verify_autostart(app, on)
    })();
    if let Some(items) = app.try_state::<TrayItems>() {
        items.retry.store(if result.is_err() { i8::from(on) } else { -1 }, Ordering::Relaxed);
    }
    // 失败不能把缓存当成实际状态，也不能把查询错误伪装为 false。
    let actual = match &result { Ok(value) => Some(*value), Err(_) => autostart_enabled(app).ok() };
    update_state(app, actual);
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
    else { Err(format!("Autostart verification failed: expected {expected}, actual {actual}")) }
}