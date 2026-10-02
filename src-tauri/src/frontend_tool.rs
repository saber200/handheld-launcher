//! 工具箱里的「前端」卡片：**只做文件级安装/更新**。
//!
//! 这里刻意不做的事：不启动前端、不结束前端、不换它的显示状态。前端是独立程序
//! （FRONTEND.md §2 的边界），启动器对它只有两件事可说：
//!   1. 读它自己写的 `frontend.json`，知道装没装、什么版本；
//!   2. 运行随启动器分发的那个前端安装包（用户点一下才动）。
//!
//! 覆盖安装前先走一次"请退出"的一次性握手（`fh_core::handshake`）：前端正开着的话，
//! 它的 exe 被占用，安装包覆盖不了。

use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

use crate::i18n::pick;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendStatus {
    /// 前端至少成功启动过一次（它启动时写 frontend.json）。
    pub installed: bool,
    pub version: String,
    pub exe: String,
    /// 随启动器一起分发的安装包在不在（开发构建里可能没有）。
    pub payload: bool,
}

#[tauri::command]
pub async fn frontend_status(app: tauri::AppHandle) -> FrontendStatus {
    let presence = fh_core::presence::read();
    FrontendStatus {
        installed: presence.is_some(),
        version: presence
            .as_ref()
            .map(|item| item.version.clone())
            .unwrap_or_default(),
        exe: presence.map(|item| item.exe).unwrap_or_default(),
        payload: payload_path(&app).is_some(),
    }
}

/// 安装 / 更新前端：先请正在跑的前端退出，再静默运行随包的安装包。
#[tauri::command]
pub async fn frontend_install(app: tauri::AppHandle) -> Result<String, String> {
    let Some(payload) = payload_path(&app) else {
        return Err(pick(
            "这个版本没有内置前端安装包。请到 Release 页面下载前端安装包安装。",
            "This build ships no frontend installer. Download it from the Releases page.",
        ));
    };
    // off_main 会把阻塞活儿挪到工作线程；它返回的是「外层 Result + 内层 Result」，
    // 这里要的是内层（安装结果）。
    match crate::off_main(move || run_installer(&payload)).await {
        Ok(result) => result,
        Err(err) => Err(err),
    }
}

/// 安装包放在资源目录的 `payload/frontend-setup.exe`（CI 会把前端安装包拷进来）。
fn payload_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let path = dir.join("payload").join("frontend-setup.exe");
    path.exists().then_some(path)
}

/// 启动器启动时补一次「前端在跑」，并顺手把「计划任务自启」补齐。
///
/// 为什么越过这里一直守的那条边界（模块开头：「不启动前端、不结束前端」）：
/// 0.1.51 的真机日志把这段空窗拍得很清楚 —— 更新完之后，安装包替用户启动的那一次前端
/// 已经没了（启动器自己记的 `overlay watch: frontend process down`，而前端那边一行退出
/// 记录都没有），用户接着按 Back+Start，按键没有任何人接，于是「还是不行」。前端平时靠
/// 开机自启起来（那时它在），只有「刚更新完、还没重启」这一段谁都不管，而启动器是这段
/// 里唯一确定在跑的一方 —— 补上它，Back+Start 才有个能接按键的人。
///
/// **0.1.53 的三处改动**（依据见 `fh_core::autostart` 顶部）：
///   1. **先补齐计划任务**：前端装着、任务不在就建一个（把老版本写的 HKCU Run 迁过来）。
///      这是「FSE 会话里前端压根不会被启动」的根治 —— Run 键由 explorer 处理，Xbox 模式
///      的会话里没有 explorer。任务也顺带管「崩溃后被拉回来」（见任务 XML 的 RestartOnFailure）。
///   2. **优先用任务启动**（`schtasks /run`）：任务写的是普通权限，而这里直接 spawn 会继承
///      启动器的**管理员**权限 —— 同一个前端两种权限，UIPI 会让它在 FSE 下的表现不一致。
///   3. **尊重用户意图**：这一轮登录里用户从托盘点过「退出前端」，就不补启动
///      （`fh_core::autostart::stopped_by_user`）；下一次登录任务会重新拉起它。
///
/// 刻意**不做看门狗**：只在启动器启动时做一次；也不结束任何进程。
/// Windows 专属：判据要扫进程表、任务要 `schtasks`。
#[cfg(windows)]
pub fn ensure_running() {
    use crate::overlay_watch::FRONTEND_EXE;

    let exe = frontend_exe(FRONTEND_EXE);

    // 1) 自启任务：装着但任务不在就建（不覆盖已存在的 —— 用户可能在托盘关掉过自启）。
    if let Some(path) = exe.as_ref() {
        match fh_core::autostart::ensure_task_if_missing(path) {
            Ok(Some(note)) => {
                crate::logutil::write_line(&format!("frontend autostart task: {note}"))
            }
            Ok(None) => {}
            Err(err) => crate::logutil::write_line(&format!(
                "frontend autostart task failed: {err}（不影响这次启动，退回直接启动）"
            )),
        }
    }

    if crate::overlay_watch::frontend_process_alive() {
        crate::logutil::write_line("frontend ensure: already running (skip start)");
        return;
    }
    if fh_core::autostart::stopped_by_user() {
        crate::logutil::write_line(
            "frontend ensure: 用户这一轮登录里主动退出过前端（托盘菜单），不补启动",
        );
        return;
    }

    // 2) 优先让计划任务来启动：普通权限、且以后崩了有人拉。
    if fh_core::autostart::task_exists() {
        match fh_core::autostart::run_task() {
            Ok(note) => {
                crate::logutil::write_line(&format!(
                    "frontend ensure: started by autostart task ({note})"
                ));
                return;
            }
            Err(err) => crate::logutil::write_line(&format!(
                "frontend ensure: task run failed: {err}（退回直接启动）"
            )),
        }
    }

    let Some(exe) = exe else {
        crate::logutil::write_line(
            "frontend ensure: not running and not installed（frontend.json 没有、默认目录也没有 —— 工具箱卡片的「安装 / 更新前端」可以装上）",
        );
        return;
    };
    match std::process::Command::new(&exe).spawn() {
        Ok(child) => crate::logutil::write_line(&format!(
            "frontend ensure: started pid={} path={}",
            child.id(),
            exe.display()
        )),
        Err(err) => crate::logutil::write_line(&format!(
            "frontend ensure: start failed: {err} path={}",
            exe.display()
        )),
    }
}

/// 前端 exe 在哪：先问它自己写的 `frontend.json`，再退回默认安装目录。
/// 两条都拿不到就是「没装」（`frontend.json` 只有它成功启动过一次才存在）。
#[cfg(windows)]
fn frontend_exe(exe_name: &str) -> Option<PathBuf> {
    fh_core::presence::read()
        .map(|presence| PathBuf::from(presence.exe))
        .filter(|path| path.exists())
        .or_else(|| default_exe(exe_name))
}

/// 非 Windows 上没有这套（也没有第二个程序来抢手柄）：只留签名，方便本机 `cargo check`
/// （与 `crate::overlay_watch::start` 同一套做法）。
#[cfg(not(windows))]
pub fn ensure_running() {}

/// 默认安装位置：`%LOCALAPPDATA%\FantasyHubFrontend\FantasyHubFrontend.exe`。
/// NSIS 的 currentUser 安装模式就装在这儿（真机日志里的 `frontend.json` 也是这条路径）；
/// 读 `frontend.json` 失败时用它兜底 —— 装好了但还没成功启动过一次时，那个文件还不存在。
/// 非 Windows 上 `LOCALAPPDATA` 根本不存在，直接返回 `None`。
#[cfg(windows)]
fn default_exe(exe_name: &str) -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let path = PathBuf::from(local)
        .join("FantasyHubFrontend")
        .join(exe_name);
    path.exists().then_some(path)
}

enum InstallOutcome {
    Installed,
    Failed(String),
}

fn run_installer(payload: &PathBuf) -> Result<String, String> {
    // 1) 请正在运行的前端退出（写标记文件，前端两秒内自己退；没在跑就白等一会儿）
    fh_core::handshake::request_quit()?;
    crate::logutil::write_line("frontend install: asked a running frontend to quit");
    std::thread::sleep(std::time::Duration::from_millis(fh_core::handshake::WAIT_MS));

    // 2) 静默安装/更新（前端安装包自己负责把文件放好、自启项交给它自己的开关）
    let outcome = match std::process::Command::new(payload).arg("/S").status() {
        Ok(status) if status.success() => InstallOutcome::Installed,
        Ok(status) => InstallOutcome::Failed(format!("安装器退出码 {}", status.code().unwrap_or(-1))),
        Err(err) => InstallOutcome::Failed(err.to_string()),
    };
    fh_core::handshake::clear();

    match outcome {
        InstallOutcome::Installed => {
            crate::logutil::write_line("frontend install: installer finished");
            Ok(pick("前端已安装 / 已更新", "Frontend installed / updated"))
        }
        InstallOutcome::Failed(detail) => {
            crate::logutil::write_line(&format!("frontend install failed: {detail}"));
            Err(pick(
                "前端安装失败。请先在托盘退出前端，再重试；也可到 Release 页面手动安装。",
                "Frontend install failed. Quit it from the tray and retry, or install manually from Releases.",
            ))
        }
    }
}
