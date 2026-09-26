mod files;
mod media;
mod scan;
mod startup;

use std::sync::atomic::Ordering;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

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
    builder
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            scan::scan_games,
            scan::scan_apps,
            scan::launch_item,
            scan::cache_covers,
            startup::autostart_enabled,
            startup::set_autostart,
            files::file_places,
            files::file_list,
            files::file_make_dir,
            files::file_make_file,
            files::file_copy,
            files::file_move,
            files::file_read_text,
            files::file_write_text,
            files::file_icon,
            files::file_open
        ])
        .setup(|app| {
            startup::repair();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_fullscreen(true);
                let watched = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Focused(true) = event {
                        if scan::RESUME_FULLSCREEN.swap(false, Ordering::Relaxed) {
                            let _ = watched.set_fullscreen(true);
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
