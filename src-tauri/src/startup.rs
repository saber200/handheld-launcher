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

/// If the user already opted in, rewrite the startup command with a quoted path.
/// The plugin wrote `C:\...\Handheld Launcher\app.exe`, which Windows splits on the space.
pub fn repair() {
    #[cfg(windows)]
    windows::repair();
}

#[cfg(windows)]
mod windows {
    use std::borrow::Cow;
    use std::path::PathBuf;

    const RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    const APPROVED_KEY: &str =
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
    const RUN_NAME: &str = "handheld-launcher";
    const ENABLED_APPROVAL: [u8; 12] = [
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, RegType};
    use winreg::{RegKey, RegValue};

    pub fn enabled() -> bool {
        run_value().is_some()
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        if enabled {
            write_current().map_err(|err| format!("无法开启开机自启：{err}"))
        } else {
            remove().map_err(|err| format!("无法关闭开机自启：{err}"))
        }
    }

    pub fn repair() {
        if run_value().is_some() {
            let _ = write_current();
        }
    }

    fn write_current() -> std::io::Result<()> {
        let exe = std::env::current_exe()?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)?
            .set_value::<_, _>(RUN_NAME, &quoted_command(&exe))?;
        if let Ok(key) = hkcu.open_subkey_with_flags(APPROVED_KEY, KEY_SET_VALUE) {
            key.set_raw_value(
                RUN_NAME,
                &RegValue {
                    vtype: RegType::REG_BINARY,
                    bytes: Cow::Owned(ENABLED_APPROVAL.to_vec()),
                },
            )?;
        }
        Ok(())
    }

    fn remove() -> std::io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)?;
        match key.delete_value(RUN_NAME) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }

    fn run_value() -> Option<String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey_with_flags(RUN_KEY, KEY_READ)
            .ok()?
            .get_value(RUN_NAME)
            .ok()
    }

    fn quoted_command(exe: &PathBuf) -> String {
        format!("\"{}\" --autostart", exe.display())
    }
}
