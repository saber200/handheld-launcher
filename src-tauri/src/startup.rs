#[tauri::command]
pub fn autostart_enabled() -> bool {
    #[cfg(windows)]
    {
        return windows::enabled();
    }
    #[cfg(not(windows))]
    false
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        return windows::set_enabled(enabled);
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("只能在 Windows 上设置开机自启".into())
    }
}

/// If the user already opted in, move that choice to the Startup folder shortcut.
/// The registry Run value splits on the space in `Handheld Launcher`.
pub fn repair() {
    #[cfg(windows)]
    windows::repair();
}

#[cfg(windows)]
mod windows {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    const APPROVED_KEY: &str =
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
    const RUN_NAMES: [&str; 2] = ["handheld-launcher", "Handheld Launcher"];

    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    pub fn enabled() -> bool {
        shortcut_path().is_some_and(|path| path.is_file())
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        if enabled {
            write_shortcut()?;
        } else if let Some(path) = shortcut_path() {
            if path.is_file() {
                std::fs::remove_file(&path).map_err(|err| format!("无法关闭开机自启：{err}"))?;
            }
        }
        clear_run_values();
        Ok(())
    }

    pub fn repair() {
        if !enabled() && !run_value_exists() {
            return;
        }
        if write_shortcut().is_ok() {
            clear_run_values();
        }
    }

    fn shortcut_path() -> Option<PathBuf> {
        let appdata = std::env::var_os("APPDATA")?;
        Some(
            PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Startup")
                .join("Handheld Launcher.lnk"),
        )
    }

    fn write_shortcut() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|err| format!("无法开启开机自启：{err}"))?;
        let lnk = shortcut_path().ok_or("无法开启开机自启：找不到启动文件夹")?;
        if let Some(dir) = lnk.parent() {
            std::fs::create_dir_all(dir).map_err(|err| format!("无法开启开机自启：{err}"))?;
        }
        let work = exe.parent().unwrap_or_else(|| Path::new("."));
        let script = format!(
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.Arguments='--autostart';$s.WorkingDirectory='{}';$s.Save()",
            ps_quote(&lnk.display().to_string()),
            ps_quote(&exe.display().to_string()),
            ps_quote(&work.display().to_string()),
        );
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &script,
            ])
            .output()
            .map_err(|err| format!("无法开启开机自启：{err}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("无法开启开机自启：{err}"));
        }
        if !lnk.is_file() {
            return Err("无法开启开机自启：没有写入启动项".into());
        }
        Ok(())
    }

    fn ps_quote(value: &str) -> String {
        value.replace('\'', "''")
    }

    fn run_value_exists() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let Ok(key) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_READ) else {
            return false;
        };
        RUN_NAMES.iter().any(|name| key.get_value::<String, _>(name).is_ok())
    }

    fn clear_run_values() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE) {
            for name in RUN_NAMES {
                let _ = key.delete_value(name);
            }
        }
        if let Ok(key) = hkcu.open_subkey_with_flags(APPROVED_KEY, KEY_SET_VALUE) {
            for name in RUN_NAMES {
                let _ = key.delete_value(name);
            }
        }
    }
}
