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

/// Run a blocking job on the runtime's blocking pool instead of the webview
/// event loop.
///
/// A plain `#[tauri::command] fn` is executed on the main thread — the same
/// thread that pumps every window message. One slow drive probe, icon
/// extraction or a cover download with a 20s read timeout therefore freezes
/// *all* windows until it returns: the shell stops repainting, Back+Start looks
/// dead and a Start press only lands after the timeout expires. Long jobs are
/// handed to a worker thread here so the IPC reply can still be slow while the
/// UI stays responsive.
pub(crate) async fn off_main<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| {
            logutil::write_line(&format!("blocking job failed: {err}"));
            format!("后台任务失败：{err}")
        })
}

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
                // Launching a game never hides the shell either: whatever we start
                // keeps the focus Windows gave it, we never grab it back.
                // The overlay is a game-time surface though: the moment the shell
                // is the window in use again it goes off screen, otherwise it
                // stays on top of the library and fights it for the pad.
                frontend::hide_overlay(&app_handle);
            }
            _ => {}
        }
    });
}

/// Bring the hidden shell back. The single-instance relaunch used this while the
/// launcher still hid itself on launch; the shell now stays visible, so this is
/// only a safety net for windows that ended up off screen.
pub(crate) fn reveal_shell(app: &tauri::AppHandle) {
    // The floating overlay is a game-time surface; the library takes over now.
    frontend::hide_overlay(app);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
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
