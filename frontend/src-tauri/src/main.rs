#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 独立前端 FantasyHubFrontend。
//
// 与启动器是两个独立程序：启动器不起它、不杀它、不发生命、不注册它的快捷键；
// 它也不读启动器的运行时状态（唯一例外是 TDP 请求，走本地 IPC，见 FRONTEND.md §4）。
//
// 生命周期：自己管开机自启（HKCU Run）→ 托盘常驻 → 两个开关浮层的方式：
//   Ctrl+H（全局热键）、手柄 Back+Start（XInput 轮询，不依赖窗口焦点）
// 关窗只隐藏；真正退出只有托盘菜单的「退出前端」。
//
// 手动看一眼（真机冒烟）：FantasyHubFrontend.exe --show
// 装好默认自启（安装包调用）：FantasyHubFrontend.exe --enable-autostart
mod chord;
mod games;
mod library;
mod overlay;
mod tdp_client;
mod text;
mod tray;

/// 把阻塞活儿丢到运行时的工作线程上，别卡住 WebView 的事件循环
/// （和启动器里的 `off_main` 同一套理由：一次进程枚举或一次 IPC 往返都不该冻住界面）。
pub(crate) async fn off_main<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| {
            fh_core::logutil::write_line(&format!("blocking job failed: {err}"));
            format!("后台任务失败：{err}")
        })
}

/// 界面切语言时同步给 Rust 侧（托盘文案等）。命令必须留在 app 自己的 crate 里，
/// 见 `fh-core/src/lib.rs` 顶部的铁律。
#[tauri::command]
fn set_locale(locale: String) {
    fh_core::i18n::apply(&locale);
}

/// 安装/更新前，安装器（或启动器工具箱）会写一个标记文件请前端退出
/// （见 `fh_core::handshake`）：看到就**真正退出进程**，好让安装器覆盖 exe。
/// 每隔两秒看一眼，代价可以忽略。
fn watch_update_handshake(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        if fh_core::handshake::quitting_requested() {
            fh_core::logutil::write_line("quit for update (asked by installer)");
            overlay::request_quit();
            app.exit(0);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(fh_core::handshake::POLL_MS));
    });
}

fn main() {
    fh_core::logutil::init_for("FantasyHubFrontend");
    // 告诉启动器（和用户）"我装在哪、什么版本"：工具箱的安装状态读这个文件，
    // 比猜 NSIS 的安装目录可靠（见 fh_core::presence）。
    if let Err(err) = fh_core::presence::record(env!("CARGO_PKG_VERSION")) {
        fh_core::logutil::write_line(&format!("presence record failed: {err}"));
    }
    text::apply_system_locale();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut builder = tauri::Builder::default();
    // 单实例必须第一个注册：第二次启动只把已经在跑的实例叫出来，不会多一个托盘图标。
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        handle_args(app, &args);
        overlay::show(app, "second instance");
    }));
    builder = builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // 界面能调的能力。TDP 走启动器的本地 IPC；进程检测/退游戏/读库清单都在本进程里
        // 完成（免提权，见 FRONTEND.md §3/§4）。
        .invoke_handler(tauri::generate_handler![
            set_locale,
            tdp_client::tdp_status,
            tdp_client::set_tdp,
            tdp_client::toolbox_tdp_driver_status,
            games::running_games,
            games::quit_game,
            library::library_read
        ])
        .setup(move |app| {
            handle_args(app.handle(), &args);
            overlay::attach_window_events(app.handle());
            tray::install(app.handle())?;
            // Ctrl+H 可能与启动器撞车（Windows 一个热键只能被一个进程注册）。
            // 撞了就只记一行日志：前端的托盘和手柄 Back+Start 仍然照常工作，
            // 绝不能因为一个热键没抢到就让整个前端起不来。
            if let Err(err) = install_hotkey(app) {
                fh_core::logutil::write_line(&format!("global shortcut unavailable: {err}"));
            }
            chord::start(app.handle().clone());
            watch_update_handshake(app.handle().clone());
            fh_core::logutil::write_line(&format!(
                "frontend ready (visible={}, autostart={})",
                overlay::is_visible(),
                tray::autostart_enabled(app.handle())
            ));
            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running FantasyHubFrontend");
}

/// 命令行参数。
///
/// 安装包用 `--enable-autostart` 实现「装好默认自启」，但前端**绝不**偷偷写注册表：
/// 只有真带了这个参数才会开（FRONTEND.md §5）。
fn handle_args(app: &tauri::AppHandle, args: &[String]) {
    let has = |flag: &str| args.iter().any(|arg| arg == flag);
    if has("--autostart") {
        fh_core::logutil::write_line("launched by autostart");
    }
    if has("--enable-autostart") {
        tray::set_autostart(app, true);
    }
    if has("--disable-autostart") {
        tray::set_autostart(app, false);
    }
    if has("--show") {
        overlay::show(app, "argv --show");
    }
}

/// Ctrl+H。注册方式与启动器里现成的实现一致（同一插件、同样只在按下时切换）。
fn install_hotkey(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_shortcuts(["Control+H"])?
            .with_handler(|app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                if shortcut.matches(Modifiers::CONTROL, Code::KeyH) {
                    overlay::toggle(app, "hotkey Control+H");
                }
            })
            .build(),
    )?;
    fh_core::logutil::write_line("global shortcut Control+H registered");
    Ok(())
}
