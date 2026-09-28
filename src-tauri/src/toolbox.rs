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

#[tauri::command]
pub fn toolbox_runtimes() -> Vec<RuntimePackage> {
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
pub fn toolbox_install_runtime(app: tauri::AppHandle, id: String) -> Result<String, String> {
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
pub fn toolbox_optiscaler_installed(launch_path: String) -> bool {
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
pub fn toolbox_install_optiscaler(app: tauri::AppHandle, launch_path: String) -> Result<String, String> {
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
    pub message: String,
}

#[tauri::command]
pub fn toolbox_tdp_driver_status() -> TdpDriverStatus {
    #[cfg(windows)]
    {
        return windows::tdp_driver_status();
    }
    #[cfg(not(windows))]
    {
        TdpDriverStatus {
            ready: false,
            elevated: false,
            message: pick(
                "TDP 驱动只能在 Windows 上安装。",
                "The TDP driver can only be installed on Windows.",
            ),
        }
    }
}

#[tauri::command]
pub fn toolbox_install_tdp_driver(app: tauri::AppHandle) -> Result<TdpDriverStatus, String> {
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
        let zip_path = cache.join("OptiScaler-latest.zip");
        let extract_dir = cache.join("optiscaler-extract");
        let _ = fs::remove_dir_all(&extract_dir);
        fs::create_dir_all(&extract_dir).map_err(|err| {
            pick(
                &format!("无法准备解压目录：{err}"),
                &format!("Couldn't prepare extract folder: {err}"),
            )
        })?;

        let download_url = latest_optiscaler_zip_url()?;
        download(&download_url, &zip_path)?;
        expand_zip(&zip_path, &extract_dir)?;

        let package_root = find_optiscaler_root(&extract_dir).ok_or_else(|| {
            pick(
                "压缩包里找不到 OptiScaler 文件。",
                "Couldn't find OptiScaler files in the archive.",
            )
        })?;

        copy_optiscaler_files(&package_root, &dir)?;
        write_marker(&dir);
        Ok(pick(
            "已安装 OptiScaler（dxgi.dll）。进游戏后按 Home 打开菜单。",
            "OptiScaler installed as dxgi.dll. Press Home in-game for the menu.",
        ))
    }

    const WINRING0_SERVICE: &str = "WinRing0_1_2_0";
    const WINRING0_URLS: [&str; 2] = [
        "https://raw.githubusercontent.com/seerge/g-helper/main/app/WinRing0x64.sys",
        "https://raw.githubusercontent.com/openhardwaremonitor/openhardwaremonitor/master/External/WinRing0/WinRing0x64.sys",
    ];

    pub fn tdp_driver_status() -> TdpDriverStatus {
        let elevated = is_elevated();
        let ready = crate::tdp::winring0_ready();
        let message = if ready {
            pick(
                "TDP 驱动可用，可以调节功耗。",
                "TDP driver is ready; power limits can be changed.",
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

        if crate::tdp::winring0_ready() {
            crate::logutil::write_line("toolbox: winring0 already ready; reinstalling");
        }

        let driver_dir = driver_dir()?;
        let sys_path = driver_dir.join("WinRing0x64.sys");
        download_winring0(&sys_path)?;
        crate::logutil::write_line(&format!(
            "toolbox: winring0 saved {}",
            sys_path.display()
        ));

        // Recreate service so a stale/broken registration can be fixed.
        let _ = run_sc(&["stop", WINRING0_SERVICE]);
        let _ = run_sc(&["delete", WINRING0_SERVICE]);
        // sc.exe requires a space after '=' inside each option token.
        let bin = format!("binPath= {}", sys_path.display());
        run_sc(&[
            "create",
            WINRING0_SERVICE,
            "type= kernel",
            "start= demand",
            &bin,
        ])?;
        run_sc(&["start", WINRING0_SERVICE]).map_err(|err| {
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

    fn download_winring0(dest: &Path) -> Result<(), String> {
        let mut last_err = String::new();
        for url in WINRING0_URLS {
            match download(url, dest) {
                Ok(()) => {
                    if dest.is_file() && dest.metadata().map(|m| m.len()).unwrap_or(0) > 10_000 {
                        return Ok(());
                    }
                    last_err = pick("下载的驱动文件过小，可能无效。", "Downloaded driver file looks too small.");
                }
                Err(err) => last_err = err,
            }
        }
        Err(pick(
            &format!("无法下载 WinRing0 驱动：{last_err}"),
            &format!("Couldn't download WinRing0: {last_err}"),
        ))
    }

    fn run_sc(args: &[&str]) -> Result<(), String> {
        let output = Command::new("sc")
            .args(args)
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

    fn latest_optiscaler_zip_url() -> Result<String, String> {
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
        for asset in assets {
            let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".zip") && lower.contains("optiscaler") {
                if let Some(url) = asset.get("browser_download_url").and_then(|v| v.as_str()) {
                    return Ok(url.to_string());
                }
            }
        }
        for asset in assets {
            let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.to_ascii_lowercase().ends_with(".zip") {
                if let Some(url) = asset.get("browser_download_url").and_then(|v| v.as_str()) {
                    return Ok(url.to_string());
                }
            }
        }
        Err(pick(
            "找不到 OptiScaler 的 zip 下载。",
            "Couldn't find an OptiScaler zip download.",
        ))
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

    fn find_optiscaler_root(extract_dir: &Path) -> Option<PathBuf> {
        if extract_dir.join("OptiScaler.dll").is_file() {
            return Some(extract_dir.to_path_buf());
        }
        let entries = fs::read_dir(extract_dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("OptiScaler.dll").is_file() {
                return Some(path);
            }
        }
        // Some packs only ship renamed dlls; look for OptiScaler.ini
        if extract_dir.join("OptiScaler.ini").is_file() {
            return Some(extract_dir.to_path_buf());
        }
        let entries = fs::read_dir(extract_dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("OptiScaler.ini").is_file() {
                return Some(path);
            }
        }
        None
    }

    fn copy_optiscaler_files(from: &Path, to: &Path) -> Result<(), String> {
        let entries = fs::read_dir(from).map_err(|err| {
            pick(
                &format!("无法读取 OptiScaler 目录：{err}"),
                &format!("Couldn't read OptiScaler folder: {err}"),
            )
        })?;
        for entry in entries.flatten() {
            let src = entry.path();
            if !src.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            // Skip installer scripts; we place files directly.
            if name_str.eq_ignore_ascii_case("setup_windows.bat")
                || name_str.eq_ignore_ascii_case("setup_windows.sh")
                || name_str.eq_ignore_ascii_case("remove_optiscaler.bat")
            {
                continue;
            }
            let dest_name = if name_str.eq_ignore_ascii_case("OptiScaler.dll") {
                PathBuf::from("dxgi.dll")
            } else {
                PathBuf::from(&name)
            };
            let dest = to.join(&dest_name);
            if dest_name.file_name().and_then(|n| n.to_str()) == Some("dxgi.dll") && dest.is_file() {
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
        // If pack had no OptiScaler.dll but already dxgi, leave as-is.
        if !to.join("dxgi.dll").is_file() {
            return Err(pick(
                "安装包里没有 OptiScaler.dll。",
                "Package is missing OptiScaler.dll.",
            ));
        }
        Ok(())
    }
}
