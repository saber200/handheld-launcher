mod files;
mod frontend;
mod i18n;
mod logutil;
mod media;
mod scan;
mod startup;
mod tdp;
mod toolbox;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

static REOPENING: AtomicBool = AtomicBool::new(false);

fn reopen_main(app: tauri::AppHandle) {
    if startup::quit_allowed() || REOPENING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        REOPENING.store(false, Ordering::SeqCst);
        if startup::quit_allowed() || app.get_webview_window("main").is_some() {
            return;
        }
        let Some(config) = app.config().app.windows.first().cloned() else {
            return;
        };
        let Ok(builder) = tauri::WebviewWindowBuilder::from_config(&app, &config) else {
            return;
        };
        let Ok(window) = builder.build() else {
            return;
        };
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.set_fullscreen(true);
        attach_main(&window, &app);
    });
}

fn attach_main(window: &tauri::WebviewWindow, app: &tauri::AppHandle) {
    let watched = window.clone();
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::CloseRequested { api, .. } => {
                if !startup::quit_allowed() {
                    api.prevent_close();
                }
            }
            WindowEvent::Destroyed => {
                if !startup::quit_allowed() {
                    reopen_main(app_handle.clone());
                }
            }
            WindowEvent::Focused(true) => {
                // Do NOT focus_frontend here — under FSE that focus fight freezes the UI.
                // Overlay must not hide or fight the main window (Game Bar style).
                if frontend::frontend_visible(&app_handle) {
                    return;
                }
                // Launch path hides the shell. FSE often force-focuses us right away —
                // re-hide during the suppress window so the game keeps the foreground.
                if scan::away_session_active() {
                    if scan::away_suppress_active() {
                        scan::rehide_shell_if_away(&app_handle);
                        return;
                    }
                    // Suppress expired and user is back on the shell — restore fullscreen.
                    scan::clear_away_session();
                    startup::fill_screen(&watched);
                    return;
                }
            }
            _ => {}
        }
    });
}

/// Bring the hidden shell back. The single-instance relaunch, the overlay's
/// 「回到启动器」 row and the post-game watcher in scan.rs all land here.
/// Fullscreen / FSE hides the shell with no task list to come back from, so
/// this is the one place that has to stay reliable.
pub(crate) fn reveal_shell(app: &tauri::AppHandle) {
    // The floating overlay is a game-time surface; the library takes over now.
    frontend::hide_overlay(app);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    scan::clear_away_session();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    startup::fill_screen(&window);
    logutil::write_line("shell revealed");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logutil::init();
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            reveal_shell(app);
        }));
    }
    builder = builder
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            scan::scan_games,
            scan::scan_apps,
            scan::launch_item,
            scan::running_games,
            scan::quit_game,
            scan::reveal_launcher,
            scan::cache_covers,
            scan::steam_library_cover,
            frontend::toggle_frontend,
            frontend::open_frontend,
            frontend::close_frontend,
            frontend::focus_frontend,
            tdp::tdp_status,
            tdp::set_tdp,
            toolbox::toolbox_runtimes,
            toolbox::toolbox_install_runtime,
            toolbox::toolbox_optiscaler_installed,
            toolbox::toolbox_install_optiscaler,
            toolbox::toolbox_tdp_driver_status,
            toolbox::toolbox_install_tdp_driver,
            startup::autostart_enabled,
            startup::set_autostart,
            startup::fse_status,
            startup::register_fse,
            startup::open_fse_settings,
            startup::open_desktop,
            startup::enter_fullscreen,
            startup::system_power,
            startup::quit_launcher,
            i18n::set_locale,
            files::file_places,
            files::file_list,
            files::file_make_dir,
            files::file_make_file,
            files::file_copy,
            files::file_move,
            files::file_delete,
            files::file_read_text,
            files::file_write_text,
            files::file_icon,
            files::file_open
        ])
        .setup(|app| {
            startup::prepare();
            logutil::write_line(&format!("log file: {}", logutil::path_for_user()));
            let resources = app.path().resource_dir().ok();
            startup::schedule_fse_registration(resources);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_fullscreen(true);
                attach_main(&window, app.handle());
            }
            frontend::preload(app.handle());
            if let Err(err) = frontend::install_hotkeys(app) {
                logutil::write_line(&format!("frontend hotkeys: {err}"));
            }
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !startup::quit_allowed() {
                api.prevent_exit();
                reopen_main(app.clone());
            }
        }
    });
}
