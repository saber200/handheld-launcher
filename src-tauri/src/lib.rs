mod files;
mod i18n;
// 库清单落盘（`library.json`）：小组件后端靠它知道「哪个游戏在跑 / 能退掉谁」。
mod library;
// 工具箱「系统维护」卡：着色器缓存 / 启动项 / 日志（FUTURE.md 功能 14 第 2 条）。
mod maintain;
mod media;
// 日志实现搬进了共享内核（crates/fh-core）。这里 re-export，
// 让仓库里所有 `crate::logutil::...` 调用点保持原样。
pub use fh_core::logutil;
mod scan;
mod startup;
// 只读的系统状态：盘的容量 / 电池（FUTURE.md 功能 14 第 10 条，K5 首页用）。
mod sysinfo;
mod tdp;
mod toolbox;
// Game Bar 小组件的后端就住在启动器里（回环传输 + 协议 + 端口/令牌发现文件）。
// 为什么不单起一个后台进程：TDP 一直只归启动器管，老架构里那个独立前端只是转发器
// —— 详细理由与代价写在 widget.rs 顶部。
mod widget;
mod widget_discovery;
mod widget_protocol;
// 文件管理要的 Windows 专属原语：清空回收站 / 安全弹出 / 读盘镜像魔数
// （见文件头说明；非 Windows 平台一律报「不支持」）。
mod winfs;

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
            WindowEvent::Destroyed if !startup::quit_allowed() => {
                reopen_main(app_handle.clone());
            }
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
            toolbox::toolbox_driver_version,
            maintain::toolbox_maintenance,
            maintain::toolbox_maintenance_clean,
            sysinfo::system_storage,
            sysinfo::system_power_status,
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
            i18n::set_locale,
            // 把库清单发布出去，给小组件后端读（见 library.rs 顶部说明）。
            library::library_publish,
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
            files::file_cancel,
            // 暂停 / 继续一条正在跑的传输（FUTURE.md 功能 15 第 3 条）。
            files::file_pause,
            // 文件管理的 Windows 专属原语（FUTURE.md 功能 15 第 1、2、4 条）。
            winfs::recycle_bin_info,
            winfs::recycle_bin_empty,
            winfs::file_eject,
            winfs::file_probe_disc
        ])
        .setup(|app| {
            startup::prepare();
            logutil::write_line(&format!("log file: {}", logutil::path_for_user()));
            let resources = app.path().resource_dir().ok();
            startup::schedule_fse_registration(resources.clone());
            // 小组件也随启动器装：CI 把它签好塞进安装包，这里每次启动幂等地补一次
            // （安装器那一步可能没跑成、或者用户从旧版本升级上来）。
            startup::schedule_widget_registration(resources);
            // 小组件的后端：绑一个随机回环端口、生成令牌、把端口/令牌写进发现文件，
            // 之后小组件（经同包 Bridge）就能来问 TDP / 游戏列表 / 语言。
            // **失败不致命**：启动器是主程序，小组件取不到数据不该连带把主界面挡在门外。
            if let Err(err) = widget::start() {
                logutil::write_line(&format!("widget backend start failed: {err}"));
            }
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
        // 关窗口 / 退出都被拦住，只能从托盘或「电源 → 退出」走（见 startup::quit_allowed）。
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !startup::quit_allowed() {
                api.prevent_exit();
                reopen_main(app.clone());
            }
        }
    });
}
