mod files;
// 工具箱里的「前端」卡片：只做文件级安装/更新（见文件头部说明）。
mod frontend_tool;
mod i18n;
mod library;
mod media;
// 手柄归属：浮层在屏上时启动器不吃手柄（见 FRONTEND.md §10）。
mod overlay_watch;
// 日志实现搬进了共享内核（独立前端也要用）。这里 re-export，
// 让仓库里所有 `crate::logutil::...` 调用点保持原样。
pub use fh_core::logutil;
mod scan;
mod startup;
mod tdp;
// TDP 的本地 IPC 服务端：独立前端只能发这三个请求（见 tdp_ipc.rs）。
mod tdp_ipc;
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
        // 重新建出来的壳还是大屏模式：让壳体在大屏里常态退出置顶层（见 overlay_watch::BIG_SCREEN）。
        crate::overlay_watch::set_big_screen(true);
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
            WindowEvent::Destroyed if !startup::quit_allowed() => {
                reopen_main(app_handle.clone());
            }
            // 这里曾有一个 `Focused(true) => frontend::hide_overlay(...)`：0.1.45 想靠
            // 「壳拿回焦点」收走浮层，结果和浮层自己的可见性状态打架，正是那一版
            // 「开机就出现、还关不掉」的成因之一。前端现在是独立程序（FRONTEND.md），
            // 两者的显示/隐藏互不相干，这段永远删掉。
            _ => {}
        }
    });
}

/// Bring the hidden shell back. The single-instance relaunch used this while the
/// launcher still hid itself on launch; the shell now stays visible, so this is
/// only a safety net for windows that ended up off screen.
pub(crate) fn reveal_shell(app: &tauri::AppHandle) {
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
    // 紧跟着 init 装 panic 钩子：崩在启动早期（插件初始化、托盘、FSE 注册）也要留下一行，
    // 否则「起来了又没了」在日志里只能看到半截启动记录，分不清是崩了还是正常退出。
    logutil::install_panic_hook("FantasyHub");
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
            tdp::tdp_status,
            tdp::set_tdp,
            toolbox::toolbox_runtimes,
            toolbox::toolbox_install_runtime,
            toolbox::toolbox_optiscaler_status,
            toolbox::toolbox_optiscaler_versions,
            toolbox::toolbox_install_optiscaler,
            toolbox::toolbox_uninstall_optiscaler,
            toolbox::toolbox_cancel_mod,
            toolbox::toolbox_tdp_driver_status,
            toolbox::toolbox_install_tdp_driver,
            startup::autostart_enabled,
            startup::set_autostart,
            startup::fse_status,
            startup::register_fse,
            startup::open_fse_settings,
            // Game Bar 小组件：看上次装的结果 / 手动重装一次（见 startup.rs 顶部说明）。
            startup::widget_status,
            startup::register_widget,
            startup::open_desktop,
            startup::enter_fullscreen,
            startup::system_power,
            startup::quit_launcher,
            // 把库清单发布给独立前端（只写文件，前端只读）。
            library::library_publish,
            // 工具箱前端卡片：看安装状态、跑随包的安装包（不含任何窗口/进程控制）。
            frontend_tool::frontend_status,
            frontend_tool::frontend_install,
            // 前端浮层在屏上时把手柄让出去（见 overlay_watch.rs / FRONTEND.md §10）。
            overlay_watch::overlay_open,
            i18n::set_locale,
            files::file_places,
            files::file_list,
            files::file_make_dir,
            files::file_make_file,
            files::file_copy,
            files::file_move,
            files::file_delete,
            files::file_extract,
            files::file_compress,
            files::files_show_keyboard,
            files::file_read_text,
            files::file_write_text,
            files::file_icon,
            files::file_thumb,
            files::file_open,
            // 文件管理器深度优化（FUTURE.md 功能 12）：改名 / 批量改名 / 属性 /
            // 搜索 / 带进度的传输。
            files::file_rename,
            files::file_rename_many,
            files::file_properties,
            files::file_dir_sizes,
            files::file_search,
            files::file_transfer,
            files::file_cancel
        ])
        .setup(|app| {
            startup::prepare();
            logutil::write_line(&format!("log file: {}", logutil::path_for_user()));
            let resources = app.path().resource_dir().ok();
            startup::schedule_fse_registration(resources.clone());
            // 小组件也随启动器装：CI 把它签好塞进安装包，这里每次启动幂等地补一次
            // （安装器那一步可能没跑成、或者用户从旧版本升级上来）。
            startup::schedule_widget_registration(resources);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_fullscreen(true);
                // 启动即大屏模式（FSE 主页应用就是这么起来的）：让壳体常态退出置顶层，
                // 浮层才不会被整屏的壳压住（0.1.53，见 overlay_watch::BIG_SCREEN）。
                crate::overlay_watch::set_big_screen(true);
                attach_main(&window, app.handle());
            }
            // 独立前端要 TDP 时来找这里（只有它提权、装着 WinRing0）。
            tdp_ipc::start();
            // 浮层在屏上时把手柄让给它：两边读的是同一份 XInput 状态。
            overlay_watch::start(app.handle().clone());
            // 更新完之后那一段空窗里前端可能谁都没在跑（0.1.51 真机日志），补一次启动：
            // 只在「确实没在跑」时动，且只做这一次 —— 见 frontend_tool::ensure_running。
            frontend_tool::ensure_running();
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application");
    app.run(|app, event| {
        match event {
            tauri::RunEvent::ExitRequested { api, .. } if !startup::quit_allowed() => {
                api.prevent_exit();
                reopen_main(app.clone());
            }
            tauri::RunEvent::Exit => fh_core::ipc::clear_discovery_if_pid(std::process::id()),
            _ => {}
        }
    });
}
