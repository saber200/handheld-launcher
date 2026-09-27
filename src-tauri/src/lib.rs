mod files;
mod media;
mod scan;
mod startup;

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
    let app_for_destroy = app.clone();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::CloseRequested { api, .. } => {
                if !startup::quit_allowed() {
                    api.prevent_close();
                }
            }
            WindowEvent::Destroyed => {
                if !startup::quit_allowed() {
                    reopen_main(app_for_destroy.clone());
                }
            }
            WindowEvent::Focused(true) => {
                if scan::take_fullscreen_resume() {
                    let _ = watched.set_fullscreen(true);
                }
            }
            _ => {}
        }
    });
}

fn reveal_running_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            reveal_running_window(app);
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
            scan::cache_covers,
            scan::steam_library_cover,
            startup::autostart_enabled,
            startup::set_autostart,
            startup::fse_status,
            startup::register_fse,
            startup::open_desktop,
            startup::quit_launcher,
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
            let resources = app.path().resource_dir().ok();
            startup::schedule_fse_registration(resources);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_fullscreen(true);
                attach_main(&window, app.handle());
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
