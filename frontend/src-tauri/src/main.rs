#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 独立、无窗口的 Game Bar 后台；不注册热键，也不创建 WebView。
mod tdp_client;
mod text;
mod tray;
mod widget;
mod widget_discovery;
mod widget_protocol;

use std::sync::atomic::{AtomicBool, Ordering};
static QUITTING: AtomicBool = AtomicBool::new(false);

pub(crate) fn request_exit(app: &tauri::AppHandle) {
    QUITTING.store(true, Ordering::Release);
    app.exit(0);
}

fn watch_update_handshake(app: tauri::AppHandle, started: std::time::SystemTime) {
    std::thread::spawn(move || loop {
        if fh_core::handshake::quitting_requested_since(started) {
            fh_core::logutil::write_line("quit for update (asked by installer)");
            request_exit(&app);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(
            fh_core::handshake::POLL_MS,
        ));
    });
}

fn main() {
    let started = std::time::SystemTime::now();
    fh_core::logutil::init_for("FantasyHubFrontend");
    fh_core::logutil::install_panic_hook("FantasyHubFrontend");
    text::apply_system_locale();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_args(app, &args);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(move |app| {
            if let Err(err) = fh_core::presence::record(env!("CARGO_PKG_VERSION")) {
                fh_core::logutil::write_line(&format!("presence record failed: {err}"));
            }
            // 发现文件只由获得单实例锁的进程发布。失败则不宣称后台已就绪。
            widget::start(app.handle().clone())?;
            if let Err(err) = tray::install(app.handle()) {
                fh_core::logutil::write_line(&format!("tray install failed: {err}"));
            }
            handle_args(app.handle(), &args);
            watch_update_handshake(app.handle().clone(), started);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running FantasyHubFrontend");
    app.run(|_app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            // 没有窗口不是退出理由；只有落盘后的主动退出或更新握手可以结束后台。
            if !QUITTING.load(Ordering::Acquire) {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            fh_core::logutil::write_line("frontend exit");
        }
        _ => {}
    });
}

fn handle_args(app: &tauri::AppHandle, args: &[String]) {
    let has = |flag: &str| args.iter().any(|arg| arg == flag);
    if has("--autostart") {
        if let Err(err) = fh_core::autostart::clear_stopped() {
            fh_core::logutil::write_line(&format!("autostart clear stopped failed: {err}"));
        }
    }
    let enabled = if has("--disable-autostart") {
        Some(false)
    } else if has("--enable-autostart") {
        Some(true)
    } else {
        None
    };
    if let Some(enabled) = enabled {
        tray::set_autostart_background(app, enabled);
    }
    // --show 是旧版兼容参数，不再尝试外部激活 Game Bar 或创建窗口。
}