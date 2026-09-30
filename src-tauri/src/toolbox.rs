use serde::Serialize;

use crate::i18n::pick;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePackage {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub installed: bool,
}

/// Downloads and unpacks archives / talks to the service manager: everything
/// here is far too slow to run on the webview event loop.
#[tauri::command]
pub async fn toolbox_runtimes() -> Vec<RuntimePackage> {
    crate::off_main(toolbox_runtimes_now).await.unwrap_or_default()
}

fn toolbox_runtimes_now() -> Vec<RuntimePackage> {
    #[cfg(windows)]
    {
        return windows::runtimes();
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub async fn toolbox_install_runtime(app: tauri::AppHandle, id: String) -> Result<String, String> {
    match crate::off_main(move || toolbox_install_runtime_now(app, id)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn toolbox_install_runtime_now(app: tauri::AppHandle, id: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows::install_runtime(&app, &id);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id);
        Err(pick(
            "运行库安装只能在 Windows 上使用。",
            "Runtime installs only work on Windows.",
        ))
    }
}

#[tauri::command]
pub async fn toolbox_optiscaler_installed(launch_path: String) -> bool {
    crate::off_main(move || toolbox_optiscaler_installed_now(launch_path))
        .await
        .unwrap_or(false)
}

fn toolbox_optiscaler_installed_now(launch_path: String) -> bool {
    #[cfg(windows)]
    {
        return windows::optiscaler_installed(&launch_path);
    }
    #[cfg(not(windows))]
    {
        let _ = launch_path;
        false
    }
}

#[tauri::command]
pub async fn toolbox_install_optiscaler(app: tauri::AppHandle, launch_path: String) -> Result<String, String> {
    match crate::off_main(move || toolbox_install_optiscaler_now(app, launch_path)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn toolbox_install_optiscaler_now(app: tauri::AppHandle, launch_path: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows::install_optiscaler(&app, &launch_path);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, launch_path);
        Err(pick(
            "OptiScaler 安装只能在 Windows 上使用。",
            "OptiScaler install only works on Windows.",
        ))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TdpDriverStatus {
    pub ready: bool,
    pub elevated: bool,
    /// Sys file / service already on disk — may only need a start after reboot.
    pub installed: bool,
    pub message: String,
}

#[tauri::command]
pub async fn toolbox_tdp_driver_status() -> TdpDriverStatus {
    crate::off_main(toolbox_tdp_driver_status_now)
        .await
        .unwrap_or_else(|err| TdpDriverStatus {
            ready: false,
            elevated: false,
            installed: false,
            message: err,
        })
}

fn toolbox_tdp_driver_status_now() -> TdpDriverStatus {
    #[cfg(windows)]
    {
        return windows::tdp_driver_status();
    }
    #[cfg(not(windows))]
    {
        TdpDriverStatus {
            ready: false,
            elevated: false,
            installed: false,
            message: pick(
                "TDP 驱动只能在 Windows 上安装。",
                "The TDP driver can only be installed on Windows.",
            ),
        }
    }
}

#[tauri::command]
pub async fn toolbox_install_tdp_driver(app: tauri::AppHandle) -> Result<TdpDriverStatus, String> {
    match crate::off_main(move || toolbox_install_tdp_driver_now(app)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn toolbox_install_tdp_driver_now(app: tauri::AppHandle) -> Result<TdpDriverStatus, String> {
    #[cfg(windows)]
    {
        return windows::install_tdp_driver(&app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(pick(
            "TDP 驱动只能在 Windows 上安装。",
            "The TDP driver can only be installed on Windows.",
        ))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use tauri::Manager;

    pub fn runtimes() -> Vec<RuntimePackage> {
        vec![
            RuntimePackage {
                id: "vc2015_2022_x64".into(),
                name: pick("Visual C++ 2015–2022 (x64)", "Visual C++ 2015–2022 (x64)"),
                detail: pick(
                    "多数新游戏依赖的官方运行库（64 位）。",
                    "Official redistributable used by most modern 64-bit games.",
                ),
                installed: vc_runtime_installed("x64"),
            },
            RuntimePackage {
                id: "vc2015_2022_x86".into(),
                name: pick("Visual C++ 2015–2022 (x86)", "Visual C++ 2015–2022 (x86)"),
                detail: pick(
                    "部分老游戏 / 32 位组件需要。",
                    "Needed by some older or 32-bit game components.",
                ),
                installed: vc_runtime_installed("x86"),
            },
            RuntimePackage {
                id: "net8_desktop_x64".into(),
                name: pick(".NET 8 桌面运行时 (x64)", ".NET 8 Desktop Runtime (x64)"),
                detail: pick(
                    "部分启动器与工具依赖。",
                    "Used by some launchers and tools.",
                ),
                installed: net_desktop_installed("8."),
            },
        ]
    }

    pub fn install_runtime(app: &tauri::AppHandle, id: &str) -> Result<String, String> {
        let (url, file_name, args) = match id {
            "vc2015_2022_x64" => (
                "https://aka.ms/vs/17/release/vc_redist.x64.exe",
                "vc_redist.x64.exe",
                vec!["/install", "/quiet", "/norestart"],
            ),
            "vc2015_2022_x86" => (
                "https://aka.ms/vs/17/release/vc_redist.x86.exe",
                "vc_redist.x86.exe",
                vec!["/install", "/quiet", "/norestart"],
            ),
            "net8_desktop_x64" => (
                "https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe",
                "windowsdesktop-runtime-8-win-x64.exe",
                vec!["/install", "/quiet", "/norestart"],
            ),
            _ => {
                return Err(pick("未知的运行库项目", "Unknown runtime package"));
            }
        };

        let cache = cache_dir(app)?;
        let installer = cache.join(file_name);
        download(url, &installer)?;
        run_installer(&installer, &args)?;
        Ok(pick("安装完成。", "Install finished."))
    }

    pub fn optiscaler_installed(launch_path: &str) -> bool {
        let Some(dir) = game_dir(launch_path) else {
            return false;
        };
        dir.join("OptiScaler.dll").is_file()
            || dir.join("dxgi.dll").is_file() && marker_present(&dir)
            || dir.join("OptiScaler.ini").is_file()
    }

    pub fn install_optiscaler(app: &tauri::AppHandle, launch_path: &str) -> Result<String, String> {
        let dir = game_dir(launch_path).ok_or_else(|| {
            pick("找不到游戏目录。", "Couldn't find the game folder.")
        })?;
        if !dir.is_dir() {
            return Err(pick("游戏目录无效。", "Game folder is invalid."));
        }

        let cache = cache_dir(app)?;
        let extract_dir = cache.join("optiscaler-extract");
        let _ = fs::remove_dir_all(&extract_dir);
        fs::create_dir_all(&extract_dir).map_err(|err| {
            pick(
                &format!("无法准备解压目录：{err}"),
                &format!("Couldn't prepare extract folder: {err}"),
            )
        })?;

        let (download_url, file_name) = latest_optiscaler_archive()?;
        let archive_path = cache.join(&file_name);
        download(&download_url, &archive_path)?;
        expand_archive(&archive_path, &extract_dir)?;

        let package_root = find_optiscaler_root(&extract_dir).ok_or_else(|| {
            pick(
                "压缩包里找不到 OptiScaler 文件。",
                "Couldn't find OptiScaler files in the archive.",
            )
        })?;

        copy_optiscaler_files(&package_root, &dir)?;
        write_marker(&dir);
        Ok(pick(
            "已安装 OptiScaler（dxgi.dll）。进游戏后按 Insert 打开菜单。",
            "OptiScaler installed as dxgi.dll. Press Insert in-game for the menu.",
        ))
    }

    const WINRING0_SERVICE: &str = "WinRing0_1_2_0";
    // Prefer CDN mirrors. G-Helper removed the raw .sys from main; LHM 0.9.3 still hosts it.
    const WINRING0_URLS: [&str; 3] = [
        "https://cdn.jsdelivr.net/gh/LibreHardwareMonitor/LibreHardwareMonitor@0.9.3/LibreHardwareMonitorLib/Resources/WinRing0x64.sys",
        "https://raw.githubusercontent.com/LibreHardwareMonitor/LibreHardwareMonitor/0.9.3/LibreHardwareMonitorLib/Resources/WinRing0x64.sys",
        "https://ghproxy.net/https://raw.githubusercontent.com/LibreHardwareMonitor/LibreHardwareMonitor/0.9.3/LibreHardwareMonitorLib/Resources/WinRing0x64.sys",
    ];
    const WINRING0_ZIP_URLS: [&str; 1] = [
        "https://github.com/seerge/g-helper/releases/download/v0.150/PluginAdvancedSettings.zip",
    ];

    pub fn tdp_driver_status() -> TdpDriverStatus {
        let elevated = is_elevated();
        let installed = winring0_present();
        let mut ready = crate::tdp::winring0_ready();
        // After reboot the service is often Stopped (was demand-start). Start it
        // instead of asking the user to "install" again.
        if !ready && elevated && installed {
            crate::logutil::write_line("toolbox: winring0 installed but not open; starting service");
            match ensure_winring0_running() {
                Ok(()) => crate::logutil::write_line("toolbox: winring0 service start attempted"),
                Err(err) => crate::logutil::write_line(&format!("toolbox: winring0 start: {err}")),
            }
            ready = crate::tdp::winring0_ready();
        }
        let message = if ready {
            pick(
                "TDP 驱动可用，可以调节功耗。",
                "TDP driver is ready; power limits can be changed.",
            )
        } else if installed && elevated {
            pick(
                "驱动文件已在，但服务没起来。可点下方启动；若仍失败再重新安装。",
                "Driver files are present, but the service isn't running. Tap Start below; reinstall only if that fails.",
            )
        } else if !elevated {
            pick(
                "还没检测到 TDP 驱动，且当前不是管理员。安装驱动需要管理员权限（启动时应有 UAC）。",
                "TDP driver not detected, and FantasyHub isn't elevated. Installing needs admin (UAC prompt on launch).",
            )
        } else {
            pick(
                "还没检测到 TDP 驱动。可点下方安装（下载 WinRing0 并注册服务）。若 Defender 拦截，需允许后重试。",
                "TDP driver not detected. Install below (downloads WinRing0 and registers the service). If Defender blocks it, allow and retry.",
            )
        };
        TdpDriverStatus {
            ready,
            elevated,
            installed,
            message,
        }
    }

    pub fn install_tdp_driver(app: &tauri::AppHandle) -> Result<TdpDriverStatus, String> {
        crate::logutil::write_line("toolbox: install tdp driver begin");
        if !is_elevated() {
            return Err(pick(
                "需要管理员权限才能安装 TDP 驱动。请确认启动 FantasyHub 时出现 UAC，并选择“是”。",
                "Admin rights are required to install the TDP driver. Confirm UAC appears when launching FantasyHub and choose Yes.",
            ));
        }

        // Already on disk from a previous boot — just start, don't wipe the service.
        if winring0_present() {
            crate::logutil::write_line("toolbox: winring0 already on disk; ensuring service");
            let _ = ensure_winring0_running();
            if crate::tdp::winring0_ready() {
                crate::logutil::write_line("toolbox: winring0 start ok (no reinstall)");
                let mut status = tdp_driver_status();
                status.message = pick(
                    "TDP 驱动已启动。现在可以在上方调节功耗。",
                    "TDP driver started. You can change power limits above.",
                );
                return Ok(status);
            }
            crate::logutil::write_line("toolbox: start failed; falling through to reinstall");
        }

        let driver_dir = driver_dir()?;
        let sys_path = driver_dir.join("WinRing0x64.sys");
        if let Some(bundled) = bundled_winring0(app) {
            crate::logutil::write_line(&format!(
                "toolbox: using bundled winring0 {}",
                bundled.display()
            ));
            fs::copy(&bundled, &sys_path).map_err(|err| {
                pick(
                    &format!("无法复制自带驱动：{err}"),
                    &format!("Couldn't copy bundled driver: {err}"),
                )
            })?;
        } else {
            download_winring0(&sys_path)?;
        }
        let sys_len = sys_path.metadata().map(|m| m.len()).unwrap_or(0);
        crate::logutil::write_line(&format!(
            "toolbox: winring0 saved {} bytes={sys_len}",
            sys_path.display()
        ));
        if sys_len < 10_000 {
            return Err(pick(
                &format!("驱动文件异常（仅 {sys_len} 字节），请重装 FantasyHub 后再试。"),
                &format!("Driver file looks wrong ({sys_len} bytes). Reinstall FantasyHub and retry."),
            ));
        }

        // Recreate service so a stale/broken registration can be fixed.
        crate::logutil::write_line("toolbox: sc stop/delete WinRing0_1_2_0");
        let _ = run_sc_line(&format!("sc stop {WINRING0_SERVICE}"));
        let _ = run_sc_line(&format!("sc delete {WINRING0_SERVICE}"));
        // auto: survive reboot so the frontend doesn't ask to "install" every cold boot.
        let create = format!(
            "sc create {WINRING0_SERVICE} type= kernel start= auto binPath= {}",
            sys_path.display()
        );
        crate::logutil::write_line(&format!("toolbox: {create}"));
        run_sc_line(&create).map_err(|err| {
            crate::logutil::write_line(&format!("toolbox: sc create failed: {err}"));
            pick(
                &format!("注册驱动服务失败：{err}"),
                &format!("Couldn't create driver service: {err}"),
            )
        })?;
        crate::logutil::write_line("toolbox: sc start WinRing0_1_2_0");
        run_sc_line(&format!("sc start {WINRING0_SERVICE}")).map_err(|err| {
            crate::logutil::write_line(&format!("toolbox: sc start failed: {err}"));
            pick(
                &format!(
                    "驱动服务启动失败：{err}。若 Windows 安全中心拦截了 WinRing0，请允许后再试；也可暂时关闭核心隔离后再装。"
                ),
                &format!(
                    "Couldn't start the driver service: {err}. If Defender blocked WinRing0, allow it and retry; Core Isolation may also block it."
                ),
            )
        })?;

        // Give the device a moment to appear.
        std::thread::sleep(std::time::Duration::from_millis(400));
        if !crate::tdp::winring0_ready() {
            crate::logutil::write_line("toolbox: winring0 service started but device still closed");
            return Err(pick(
                "服务已启动，但仍打不开 WinRing0 设备。请查看安全中心是否隔离了驱动，或重启后再试。",
                "Service started, but WinRing0 still won't open. Check Defender quarantine, or reboot and retry.",
            ));
        }

        crate::logutil::write_line("toolbox: install tdp driver ok");
        let mut status = tdp_driver_status();
        status.message = pick(
            "TDP 驱动已安装。现在可以在上方调节功耗。",
            "TDP driver installed. You can change power limits above.",
        );
        let _ = app;
        Ok(status)
    }

    fn winring0_present() -> bool {
        driver_dir()
            .ok()
            .map(|dir| {
                let sys = dir.join("WinRing0x64.sys");
                sys.is_file() && sys.metadata().map(|m| m.len()).unwrap_or(0) > 10_000
            })
            .unwrap_or(false)
    }

    /// Start existing service; also flip to auto so the next reboot is quieter.
    fn ensure_winring0_running() -> Result<(), String> {
        let _ = run_sc_line(&format!("sc config {WINRING0_SERVICE} start= auto"));
        match run_sc_line(&format!("sc start {WINRING0_SERVICE}")) {
            Ok(()) => {}
            Err(err) => {
                // Already running is fine — sc start returns non-zero then.
                let lower = err.to_ascii_lowercase();
                if !(lower.contains("1056")
                    || lower.contains("already")
                    || lower.contains("正在运行")
                    || lower.contains("已启动"))
                {
                    // Still sleep/check; device may come up from a racing start.
                    crate::logutil::write_line(&format!("toolbox: sc start note: {err}"));
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
        if crate::tdp::winring0_ready() {
            Ok(())
        } else {
            Err(pick(
                "无法打开 WinRing0 设备。",
                "Couldn't open the WinRing0 device.",
            ))
        }
    }

    fn is_elevated() -> bool {
        unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
    }

    fn driver_dir() -> Result<PathBuf, String> {
        let base = std::env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        let dir = base.join("FantasyHub").join("drivers");
        fs::create_dir_all(&dir).map_err(|err| {
            pick(
                &format!("无法创建驱动目录：{err}"),
                &format!("Couldn't create driver folder: {err}"),
            )
        })?;
        Ok(dir)
    }

    fn bundled_winring0(app: &tauri::AppHandle) -> Option<PathBuf> {
        let dir = app.path().resource_dir().ok()?;
        for candidate in [
            dir.join("drivers").join("WinRing0x64.sys"),
            dir.join("WinRing0x64.sys"),
        ] {
            if candidate.is_file() && candidate.metadata().map(|m| m.len()).unwrap_or(0) > 10_000 {
                return Some(candidate);
            }
        }
        None
    }

    fn download_winring0(dest: &Path) -> Result<(), String> {
        let mut last_err = String::new();
        for url in WINRING0_URLS {
            crate::logutil::write_line(&format!("toolbox: fetch winring0 {url}"));
            match download_file(url, dest) {
                Ok(()) => {
                    let len = dest.metadata().map(|m| m.len()).unwrap_or(0);
                    if dest.is_file() && len > 10_000 {
                        crate::logutil::write_line(&format!(
                            "toolbox: winring0 download ok bytes={len} from {url}"
                        ));
                        return Ok(());
                    }
                    let _ = fs::remove_file(dest);
                    last_err = pick(
                        &format!("下载的驱动文件过小（{len} 字节），可能无效。"),
                        &format!("Downloaded driver looks too small ({len} bytes)."),
                    );
                }
                Err(err) => {
                    crate::logutil::write_line(&format!("toolbox: winring0 fetch failed: {err}"));
                    last_err = err;
                }
            }
        }
        for url in WINRING0_ZIP_URLS {
            crate::logutil::write_line(&format!("toolbox: fetch winring0 zip {url}"));
            match download_winring0_from_zip(url, dest) {
                Ok(()) => return Ok(()),
                Err(err) => {
                    crate::logutil::write_line(&format!("toolbox: winring0 zip failed: {err}"));
                    last_err = err;
                }
            }
        }
        Err(pick(
            &format!(
                "无法下载 WinRing0 驱动（网络异常）：{last_err}。可换网络/开代理后重试，或稍后再试。"
            ),
            &format!(
                "Couldn't download WinRing0 (network): {last_err}. Try another network/proxy, then retry."
            ),
        ))
    }

    fn download_winring0_from_zip(url: &str, dest: &Path) -> Result<(), String> {
        let parent = dest.parent().ok_or_else(|| {
            pick("驱动目录无效", "Driver folder is invalid.")
        })?;
        let zip_path = parent.join("winring0-src.zip");
        let extract_dir = parent.join("winring0-extract");
        let _ = fs::remove_dir_all(&extract_dir);
        fs::create_dir_all(&extract_dir).map_err(|err| {
            pick(
                &format!("无法准备解压目录：{err}"),
                &format!("Couldn't prepare extract folder: {err}"),
            )
        })?;
        download_file(url, &zip_path)?;
        let status = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    zip_path.to_string_lossy().replace('\'', "''"),
                    extract_dir.to_string_lossy().replace('\'', "''")
                ),
            ])
            .status()
            .map_err(|err| format!("expand: {err}"))?;
        if !status.success() {
            return Err(pick("解压 WinRing0 安装包失败。", "Failed to extract WinRing0 package."));
        }
        let found = find_named_file(&extract_dir, "WinRing0x64.sys").ok_or_else(|| {
            pick(
                "安装包里找不到 WinRing0x64.sys。",
                "Couldn't find WinRing0x64.sys in the package.",
            )
        })?;
        fs::copy(&found, dest).map_err(|err| {
            pick(
                &format!("无法复制驱动：{err}"),
                &format!("Couldn't copy driver: {err}"),
            )
        })?;
        let _ = fs::remove_file(&zip_path);
        let _ = fs::remove_dir_all(&extract_dir);
        let len = dest.metadata().map(|m| m.len()).unwrap_or(0);
        if len > 10_000 {
            crate::logutil::write_line(&format!(
                "toolbox: winring0 zip ok bytes={len} from {url}"
            ));
            Ok(())
        } else {
            Err(pick(
                &format!("解压出的驱动过小（{len} 字节）。"),
                &format!("Extracted driver looks too small ({len} bytes)."),
            ))
        }
    }

    fn find_named_file(root: &Path, name: &str) -> Option<PathBuf> {
        let direct = root.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        let entries = fs::read_dir(root).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = find_named_file(&path, name) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
            {
                return Some(path);
            }
        }
        None
    }

    /// Prefer Windows curl.exe / PowerShell — ureq often fails on CN links to GitHub.
    fn download_file(url: &str, dest: &Path) -> Result<(), String> {
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::remove_file(dest);
        if download_with_curl(url, dest).is_ok() {
            return Ok(());
        }
        if download_with_powershell(url, dest).is_ok() {
            return Ok(());
        }
        download(url, dest)
    }

    fn download_with_curl(url: &str, dest: &Path) -> Result<(), String> {
        let status = Command::new("curl.exe")
            .args([
                "-fsSL",
                "--connect-timeout",
                "20",
                "--max-time",
                "120",
                "-A",
                "FantasyHub-Toolbox",
                "-o",
            ])
            .arg(dest)
            .arg(url)
            .status()
            .map_err(|err| format!("curl: {err}"))?;
        if status.success() && dest.is_file() {
            Ok(())
        } else {
            Err(format!("curl exit {:?}", status.code()))
        }
    }

    fn download_with_powershell(url: &str, dest: &Path) -> Result<(), String> {
        let dest_ps = dest.to_string_lossy().replace('\'', "''");
        let url_ps = url.replace('\'', "''");
        let script = format!(
            "Invoke-WebRequest -Uri '{url_ps}' -OutFile '{dest_ps}' -UseBasicParsing -UserAgent 'FantasyHub-Toolbox'"
        );
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .output()
            .map_err(|err| format!("powershell: {err}"))?;
        if output.status.success() && dest.is_file() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            Err(format!("powershell: {}", err.trim()))
        }
    }

    fn run_sc_line(cmdline: &str) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = Command::new("cmd.exe")
            .args(["/C", cmdline])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|err| {
                pick(
                    &format!("无法运行 sc：{err}"),
                    &format!("Couldn't run sc: {err}"),
                )
            })?;
        if output.status.success() {
            return Ok(());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = format!("{}{}", stdout.trim(), stderr.trim());
        Err(if detail.is_empty() {
            pick(
                &format!("sc 退出码：{:?}", output.status.code()),
                &format!("sc exit code: {:?}", output.status.code()),
            )
        } else {
            detail
        })
    }

    fn vc_runtime_installed(arch: &str) -> bool {
        let key = format!(r"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\{arch}");
        let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
        if let Ok(sub) = hklm.open_subkey(&key) {
            if let Ok(1u32) = sub.get_value("Installed") {
                return true;
            }
        }
        false
    }

    fn net_desktop_installed(prefix: &str) -> bool {
        let output = Command::new("dotnet")
            .args(["--list-runtimes"])
            .output();
        let Ok(output) = output else {
            return false;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines().any(|line| {
            line.starts_with("Microsoft.WindowsDesktop.App ") && line.contains(prefix)
        })
    }

    fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|err| {
                pick(
                    &format!("无法定位缓存目录：{err}"),
                    &format!("Couldn't locate cache folder: {err}"),
                )
            })?
            .join("toolbox");
        fs::create_dir_all(&dir).map_err(|err| {
            pick(
                &format!("无法创建缓存目录：{err}"),
                &format!("Couldn't create cache folder: {err}"),
            )
        })?;
        Ok(dir)
    }

    fn download(url: &str, dest: &Path) -> Result<(), String> {
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let response = ureq::get(url)
            .set("User-Agent", "FantasyHub-Toolbox")
            .call()
            .map_err(|err| {
                pick(
                    &format!("下载失败：{err}"),
                    &format!("Download failed: {err}"),
                )
            })?;
        let mut reader = response.into_reader();
        let mut file = fs::File::create(dest).map_err(|err| {
            pick(
                &format!("无法写入下载文件：{err}"),
                &format!("Couldn't write download: {err}"),
            )
        })?;
        std::io::copy(&mut reader, &mut file).map_err(|err| {
            pick(
                &format!("保存下载失败：{err}"),
                &format!("Couldn't save download: {err}"),
            )
        })?;
        Ok(())
    }

    fn run_installer(path: &Path, args: &[&str]) -> Result<(), String> {
        let status = Command::new(path)
            .args(args)
            .status()
            .map_err(|err| {
                pick(
                    &format!("无法启动安装程序：{err}"),
                    &format!("Couldn't start installer: {err}"),
                )
            })?;
        // MSI quiet installs often return 0 or 3010 (reboot required).
        if status.success() || status.code() == Some(3010) {
            return Ok(());
        }
        Err(pick(
            &format!("安装程序退出码：{:?}", status.code()),
            &format!("Installer exit code: {:?}", status.code()),
        ))
    }

    fn game_dir(launch_path: &str) -> Option<PathBuf> {
        let path = PathBuf::from(launch_path.trim());
        path.parent().map(|p| p.to_path_buf())
    }

    fn marker_present(dir: &Path) -> bool {
        dir.join(".fantasyhub-optiscaler").is_file()
    }

    fn write_marker(dir: &Path) {
        let _ = fs::write(dir.join(".fantasyhub-optiscaler"), b"dxgi\n");
    }

    /// OptiScaler 官方 Release 从 0.4 起只发 `.7z`，所以这里按扩展名挑压缩包，
    /// 不能只认 `.zip`（旧实现因此永远找不到下载）。
    /// 返回 (下载地址, 本地缓存文件名)。
    fn latest_optiscaler_archive() -> Result<(String, String), String> {
        let body = ureq::get("https://api.github.com/repos/optiscaler/OptiScaler/releases/latest")
            .set("User-Agent", "FantasyHub-Toolbox")
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|err| {
                pick(
                    &format!("无法查询 OptiScaler 版本：{err}"),
                    &format!("Couldn't query OptiScaler release: {err}"),
                )
            })?
            .into_string()
            .map_err(|err| {
                pick(
                    &format!("读取版本信息失败：{err}"),
                    &format!("Couldn't read release info: {err}"),
                )
            })?;
        let json: serde_json::Value = serde_json::from_str(&body).map_err(|err| {
            pick(
                &format!("解析版本信息失败：{err}"),
                &format!("Couldn't parse release info: {err}"),
            )
        })?;
        let assets = json
            .get("assets")
            .and_then(|v| v.as_array())
            .ok_or_else(|| pick("Release 没有附件。", "Release has no assets."))?;
        let mut fallback: Option<(String, String)> = None;
        for asset in assets {
            let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let lower = name.to_ascii_lowercase();
            let extension = if lower.ends_with(".7z") {
                ".7z"
            } else if lower.ends_with(".zip") {
                ".zip"
            } else {
                continue;
            };
            let Some(url) = asset.get("browser_download_url").and_then(|v| v.as_str()) else {
                continue;
            };
            let entry = (url.to_string(), format!("OptiScaler-latest{extension}"));
            if lower.contains("optiscaler") {
                return Ok(entry);
            }
            if fallback.is_none() {
                fallback = Some(entry);
            }
        }
        fallback.ok_or_else(|| {
            pick(
                "找不到 OptiScaler 的压缩包下载。",
                "Couldn't find an OptiScaler archive download.",
            )
        })
    }

    /// 官方包是 `.7z`（个别老包是 `.zip`），按扩展名选解压方式。
    fn expand_archive(archive: &Path, dest: &Path) -> Result<(), String> {
        let is_7z = archive
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("7z"));
        if is_7z {
            expand_7z(archive, dest)
        } else {
            expand_zip(archive, dest)
        }
    }

    /// `Expand-Archive` 只认 zip；7z 用纯 Rust 解（官方包带 BCJ2 过滤器）。
    fn expand_7z(archive: &Path, dest: &Path) -> Result<(), String> {
        // sevenz-rust2 要求目标是绝对路径，且不接受含 `..` 的路径。
        let dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
        sevenz_rust2::decompress_file(archive, &dest).map_err(|err| {
            pick(
                &format!("解压 OptiScaler 失败：{err}"),
                &format!("Failed to extract OptiScaler: {err}"),
            )
        })
    }

    fn expand_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    escape_ps(zip_path),
                    escape_ps(dest)
                ),
            ])
            .status()
            .map_err(|err| {
                pick(
                    &format!("无法解压：{err}"),
                    &format!("Couldn't extract archive: {err}"),
                )
            })?;
        if status.success() {
            Ok(())
        } else {
            Err(pick("解压 OptiScaler 失败。", "Failed to extract OptiScaler."))
        }
    }

    fn escape_ps(path: &Path) -> String {
        path.to_string_lossy().replace('\'', "''")
    }

    /// 安装包里的 `OptiScaler.dll` 所在目录即「包根」，展开后可能嵌在子目录里。
    fn find_optiscaler_root(extract_dir: &Path) -> Option<PathBuf> {
        let dll = find_named_file(extract_dir, "OptiScaler.dll")
            .or_else(|| find_named_file(extract_dir, "OptiScaler.ini"))?;
        Some(
            dll.parent()
                .map(|parent| parent.to_path_buf())
                .unwrap_or_else(|| extract_dir.to_path_buf()),
        )
    }

    fn copy_optiscaler_files(from: &Path, to: &Path) -> Result<(), String> {
        let mut copied_dll = false;
        copy_optiscaler_dir(from, from, to, &mut copied_dll)?;
        if !copied_dll {
            return Err(pick(
                "安装包里没有 OptiScaler.dll。",
                "Package is missing OptiScaler.dll.",
            ));
        }
        Ok(())
    }

    /// 逐层拷贝安装包内容：保留 `D3D12_Optiscaler/`、`Licenses/` 等子目录
    /// （官方 0.9.x 的这些文件必须一起进游戏目录），`OptiScaler.dll` 改名成
    /// `dxgi.dll` 放到游戏目录根。
    fn copy_optiscaler_dir(
        root: &Path,
        dir: &Path,
        to: &Path,
        copied_dll: &mut bool,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|err| {
            pick(
                &format!("无法读取 OptiScaler 目录：{err}"),
                &format!("Couldn't read OptiScaler folder: {err}"),
            )
        })?;
        for entry in entries.flatten() {
            let src = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let rel = src.strip_prefix(root).unwrap_or(Path::new(&*name_str));
            if src.is_dir() {
                let dest_dir = to.join(rel);
                fs::create_dir_all(&dest_dir).map_err(|err| {
                    pick(
                        &format!("无法创建目录 {}：{err}", dest_dir.display()),
                        &format!("Couldn't create {}: {err}", dest_dir.display()),
                    )
                })?;
                copy_optiscaler_dir(root, &src, to, copied_dll)?;
                continue;
            }
            if !src.is_file() {
                continue;
            }
            // 官方的「!! EXTRACT ALL FILES !!」提示与 setup/remove 脚本不进游戏目录。
            if name_str.starts_with("!!") || is_setup_script(&name_str) {
                continue;
            }
            // 已有的 OptiScaler.ini 是用户配置，重装时保留。
            // 用 rel 而不是写死文件名：子目录（如 D3D12_Optiscaler/）里的 INI 也要查对位置，
            // 根目录时 rel 就是 OptiScaler.ini，行为不变。
            if name_str.eq_ignore_ascii_case("OptiScaler.ini") && to.join(rel).is_file()
            {
                continue;
            }
            let is_optiscaler_dll = name_str.eq_ignore_ascii_case("OptiScaler.dll");
            let dest_name = if is_optiscaler_dll {
                *copied_dll = true;
                PathBuf::from("dxgi.dll")
            } else {
                rel.to_path_buf()
            };
            let dest = to.join(&dest_name);
            if is_optiscaler_dll && dest.is_file() {
                // 游戏自带的 dxgi.dll 先留一份备份，别直接盖掉。
                let bak = to.join("dxgi.dll.fantasyhub.bak");
                if !bak.is_file() {
                    let _ = fs::copy(&dest, &bak);
                }
            }
            fs::copy(&src, &dest).map_err(|err| {
                pick(
                    &format!("无法写入 {}：{err}", dest_name.display()),
                    &format!("Couldn't write {}: {err}", dest_name.display()),
                )
            })?;
        }
        Ok(())
    }

    /// 官方的安装 / 卸载脚本（`setup_windows.bat`、`setup_linux.sh` 等）不进游戏目录。
    fn is_setup_script(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        [".bat", ".cmd", ".ps1", ".sh"]
            .iter()
            .any(|ext| lower.ends_with(ext))
    }
}
