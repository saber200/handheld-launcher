#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--fse-watch") {
        handheld_launcher_lib::watch_fullscreen_experience();
        return;
    }
    handheld_launcher_lib::run()
}
