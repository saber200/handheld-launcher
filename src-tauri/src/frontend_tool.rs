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
        )
        .into());
    };
    let message = crate::off_main(move || run_installer(&payload)).await?;
    Ok(message)
}

/// 安装包放在资源目录的 `payload/frontend-setup.exe`（CI 会把前端安装包拷进来）。
fn payload_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let path = dir.join("payload").join("frontend-setup.exe");
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
            Ok(pick("前端已安装 / 已更新", "Frontend installed / updated").into())
        }
        InstallOutcome::Failed(detail) => {
            crate::logutil::write_line(&format!("frontend install failed: {detail}"));
            Err(pick(
                "前端安装失败。请先在托盘退出前端，再重试；也可到 Release 页面手动安装。",
                "Frontend install failed. Quit it from the tray and retry, or install manually from Releases.",
            )
            .into())
        }
    }
}
