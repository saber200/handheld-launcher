use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use tauri::Manager;

#[cfg(not(windows))]
use crate::i18n::pick;

static QUIT_ALLOWED: AtomicBool = AtomicBool::new(false);

pub fn quit_allowed() -> bool {
    QUIT_ALLOWED.load(Ordering::SeqCst)
}

/// User chose 退出. Do not bring the window back in this session.
pub fn request_quit() {
    QUIT_ALLOWED.store(true, Ordering::SeqCst);
    #[cfg(windows)]
    windows::hold_until_next_sign_in();
}

#[tauri::command]
pub fn quit_launcher(app: tauri::AppHandle) {
    use tauri::Manager;
    request_quit();
    crate::logutil::write_line("quit_launcher");
    for (_, window) in app.webview_windows() {
        let _ = window.destroy();
    }
    app.exit(0);
    // If ExitRequested is still prevented somehow, force the process down.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(800));
        std::process::exit(0);
    });
}

#[tauri::command]
pub fn open_desktop(window: tauri::WebviewWindow) -> Result<(), String> {
    let _ = window.set_fullscreen(false);
    let _ = window.unminimize();
    let _ = window.show();
    #[cfg(windows)]
    {
        windows::start_explorer();
        return Ok(());
    }
    #[cfg(not(windows))]
    Err(pick("只能在 Windows 上打开桌面", "The desktop can only be opened on Windows.").into())
}

#[tauri::command]
pub fn enter_fullscreen(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::scan::clear_away_session();
    fill_screen(&window);
    Ok(())
}

/// Leave maximized state, then size the window to the whole monitor.
/// A maximized borderless window is clamped to the work area, which leaves a taskbar-sized gap.
pub fn fill_screen(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.unmaximize();
    let _ = window.set_decorations(false);
    let _ = window.set_fullscreen(false);
    cover_monitor(window);
    let _ = window.set_fullscreen(true);
    cover_monitor(window);
    let _ = window.set_focus();
}

fn cover_monitor(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let position = monitor.position();
    let size = monitor.size();
    let _ = window.set_position(tauri::PhysicalPosition::new(position.x, position.y));
    let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
}

#[tauri::command]
pub fn system_power(action: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        return windows::system_power(&action);
    }
    #[cfg(not(windows))]
    {
        let _ = action;
        Err(pick("只能在 Windows 上休眠、重启或关机", "Sleep, restart, and shut down only work on Windows.").into())
    }
}

pub fn schedule_fse_registration(resource_dir: Option<std::path::PathBuf>) {
    #[cfg(windows)]
    windows::schedule_fse_registration(resource_dir);
    #[cfg(not(windows))]
    {
        let _ = resource_dir;
    }
}

#[tauri::command]
pub fn fse_status() -> String {
    #[cfg(windows)]
    {
        return windows::fse_status();
    }
    #[cfg(not(windows))]
    pick("只能在 Windows 上登记全屏体验。", "Fullscreen experience can only be registered on Windows.").into()
}

#[tauri::command]
pub fn register_fse(app: tauri::AppHandle) -> String {
    #[cfg(windows)]
    {
        let dir = app.path().resource_dir().ok();
        // Settings button: allow remove+readd. Startup auto path uses force=false.
        return windows::register_fse(dir.as_deref(), true);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        pick("只能在 Windows 上登记全屏体验。", "Fullscreen experience can only be registered on Windows.").into()
    }
}

#[tauri::command]
pub fn open_fse_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        return windows::open_fse_settings();
    }
    #[cfg(not(windows))]
    Err(pick(
        "只能在 Windows 上打开全屏体验设置。",
        "Fullscreen experience settings are only available on Windows.",
    )
    .into())
}

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
        Err(pick("只能在 Windows 上设置开机自启", "Startup can only be changed on Windows.").into())
    }
}

/// Keep a previous opt-in, and drop the "do not restart" mark from an earlier quit.
pub fn prepare() {
    #[cfg(windows)]
    windows::prepare();
}

#[cfg(windows)]
mod windows {
    use crate::i18n::pick;
    use std::path::PathBuf;
    use std::process::Command;

    const RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    const APPROVED_KEY: &str =
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
    const RUN_NAMES: [&str; 2] = ["handheld-launcher", "FantasyHub"];

    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    const WATCH_TASK: &str = "FantasyHub Watch";
    const OLD_TASK: &str = "FantasyHub";
    const SHELL_KEY: &str = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon";

    pub fn enabled() -> bool {
        run_value_exists()
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        if enabled {
            enable_login()?;
        } else {
            disable_autostart();
        }
        Ok(())
    }

    /// Drop a shell takeover from 0.1.6/0.1.7, then keep a normal login start if the user had opted in.
    pub fn prepare() {
        clear_suppress();
        let opted_in = shell_is_ours() || keep_alive_exists() || old_launch_exists() || run_value_exists();
        release_shell();
        if !opted_in {
            return;
        }
        let _ = write_run_value();
        delete_task(OLD_TASK);
        remove_shortcut();
    }

    pub fn hold_until_next_sign_in() {
        if let Some(dir) = state_dir() {
            let _ = std::fs::write(dir.join("suppress"), "");
        }
        release_shell();
    }

    pub fn start_explorer() {
        let _ = Command::new("explorer.exe").spawn();
    }

    pub fn system_power(action: &str) -> Result<(), String> {
        match action {
            "sleep" => {
                use windows_sys::Win32::System::Power::SetSuspendState;
                let ok = unsafe { SetSuspendState(false, true, false) };
                if ok {
                    Ok(())
                } else {
                    Err(pick("无法休眠", "Couldn't sleep.").into())
                }
            }
            "restart" => {
                super::request_quit();
                run_shutdown(&["/r", "/t", "0"])
            }
            "shutdown" => {
                super::request_quit();
                run_shutdown(&["/s", "/t", "0"])
            }
            _ => Err(pick("未知的电源操作", "Unknown power action.").into()),
        }
    }

    fn run_shutdown(args: &[&str]) -> Result<(), String> {
        let status = hidden(&mut Command::new("shutdown.exe"))
            .args(args)
            .status()
            .map_err(|err| pick(&format!("无法执行：{err}"), &format!("Couldn't run that: {err}")))?;
        if status.success() {
            Ok(())
        } else {
            Err(pick("Windows 没有接受这个电源操作。", "Windows did not accept this power action.").into())
        }
    }

    const REGISTER_PS1: &str = include_str!("../fse/register.ps1");

    pub fn schedule_fse_registration(resource_dir: Option<std::path::PathBuf>) {
        std::thread::spawn(move || {
            // Delay so splash isn't racing package remove/re-add on slow disks.
            std::thread::sleep(std::time::Duration::from_secs(2));
            ensure_fse_launch_alias();
            let _ = register_fse(resource_dir.as_deref(), false);
        });
    }

    /// Sparse FSE ExternalLocation launches `FantasyHub.exe` from the install dir.
    /// Older builds only shipped `handheld-launcher.exe` — copy/refresh the alias.
    fn ensure_fse_launch_alias() {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let Some(dir) = exe.parent() else {
            return;
        };
        let name = exe
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if name.eq_ignore_ascii_case("FantasyHub.exe") {
            return;
        }
        let alias = dir.join("FantasyHub.exe");
        match std::fs::copy(&exe, &alias) {
            Ok(_) => crate::logutil::write_line(&format!(
                "fse alias: {} -> {}",
                exe.display(),
                alias.display()
            )),
            Err(err) => crate::logutil::write_line(&format!("fse alias copy failed: {err}")),
        }
    }

    pub fn fse_status() -> String {
        state_dir()
            .and_then(|dir| std::fs::read_to_string(dir.join("fse-status.txt")).ok())
            .and_then(|text| clean_fse_status(&text))
            .unwrap_or_else(|| pick("还没有登记到全屏体验。", "Not registered for fullscreen experience yet.").into())
    }

    pub fn register_fse(resource_dir: Option<&std::path::Path>, force: bool) -> String {
        let result = match register_fse_inner(resource_dir, force) {
            Ok(text) => text,
            Err(text) => text,
        };
        crate::logutil::write_line(&format!("fse register: {result}"));
        if let Some(dir) = state_dir() {
            let _ = std::fs::write(dir.join("fse-status.txt"), &result);
            if let Ok(detail) = std::fs::read_to_string(dir.join("fse-last-error.txt")) {
                let trimmed = detail.trim();
                if !trimmed.is_empty() {
                    crate::logutil::write_line(&format!("fse detail: {trimmed}"));
                }
            }
        }
        result
    }

    fn register_fse_inner(resource_dir: Option<&std::path::Path>, force: bool) -> Result<String, String> {
        ensure_fse_launch_alias();
        let (msix, cer) = fse_payload(resource_dir)?;
        let exe = std::env::current_exe().map_err(|err| pick(&format!("无法登记：{err}"), &format!("Couldn't register: {err}")))?;
        let exe_dir = exe.parent().ok_or_else(|| pick("无法登记：找不到安装目录", "Couldn't register: install folder not found"))?;
        let exe_name = exe
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| pick("无法登记：程序名不能用", "Couldn't register: the program name can't be used"))?;
        let dir = state_dir().ok_or_else(|| pick("无法登记：找不到数据目录", "Couldn't register: data folder not found"))?;
        let script = dir.join("register-fse.ps1");
        // Windows PowerShell 5.1 mis-parses UTF-8 scripts without BOM when any
        // non-ASCII sneaks in; always write UTF-8 with BOM.
        let mut script_bytes = vec![0xEF, 0xBB, 0xBF];
        script_bytes.extend_from_slice(REGISTER_PS1.as_bytes());
        std::fs::write(&script, script_bytes)
            .map_err(|err| pick(&format!("无法登记：{err}"), &format!("Couldn't register: {err}")))?;
        // Strip \\?\ so Add-AppxPackage does not treat the path as a broken URI.
        let msix_arg = for_powershell_path(&msix);
        let cer_arg = for_powershell_path(&cer);
        let exe_dir_arg = for_powershell_path(exe_dir);
        crate::logutil::write_line(&format!(
            "fse register begin force={force} msix={msix_arg} cer={cer_arg} exe={}",
            for_powershell_path(&exe)
        ));
        let mut command = Command::new("powershell.exe");
        let cmd = hidden(&mut command);
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script)
        .arg("-Msix")
        .arg(&msix_arg)
        .arg("-Cer")
        .arg(&cer_arg)
        .arg("-ExeDir")
        .arg(&exe_dir_arg)
        .arg("-ExeName")
        .arg(exe_name);
        if force {
            cmd.arg("-Force");
        }
        let output = cmd
            .output()
            .map_err(|err| pick(&format!("无法登记：{err}"), &format!("Couldn't register: {err}")))?;
        let token = ps_token(&output.stdout);
        let err_text = ps_token(&output.stderr);
        if !err_text.is_empty() {
            crate::logutil::write_line(&format!("fse stderr: {err_text}"));
            if let Some(dir) = state_dir() {
                let _ = std::fs::write(dir.join("fse-last-error.txt"), &err_text);
            }
        }
        if output.status.success() && token == "OK" {
            return Ok(fse_user_text("OK"));
        }
        let mapped = if token.is_empty() {
            if err_text.to_ascii_lowercase().contains("parsererror")
                || err_text.contains("字符")
                || err_text.contains("UnexpectedToken")
            {
                "SCRIPT_FAIL"
            } else {
                "FAIL"
            }
        } else {
            token.as_str()
        };
        Err(fse_user_text(mapped))
    }

    /// Tauri resource paths may use the \\?\ extended prefix; PowerShell AppX APIs hate that.
    fn for_powershell_path(path: &std::path::Path) -> String {
        let raw = path.to_string_lossy();
        let trimmed = if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            raw.into_owned()
        };
        trimmed.replace('/', "\\")
    }

    fn ps_token(bytes: &[u8]) -> String {
        let text = if bytes.len() >= 2 && bytes[1] == 0 {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(bytes).into_owned()
        };
        text.lines()
            .map(|line| line.trim().trim_start_matches('\u{feff}'))
            .find(|line| !line.is_empty())
            .unwrap_or("")
            .to_string()
    }

    fn fse_user_text(token: &str) -> String {
        match token {
            "OK" => pick(
                "已登记。请打开 Windows 设置 → 游戏 → Xbox 模式(全屏体验)，把主页应用选成「幻想枢纽」。",
                "Registered. Open Windows Settings → Gaming → Xbox mode (FSE) and choose FantasyHub as the home app.",
            ),
            "NEED_DEVMODE" => pick(
                "需要先打开开发人员模式。到 设置 → 系统 → 开发者选项，打开之后再点「登记全屏体验」。",
                "Turn on Developer Mode first (Settings → System → For developers), then register again.",
            ),
            "NO_EXE" => pick(
                "安装目录里没有启动器，无法登记全屏体验。",
                "The launcher isn't in the install folder, so fullscreen experience can't be registered.",
            ),
            "EMPTY_PAYLOAD" => pick(
                "安装包里的全屏体验身份文件无效或为空，请安装完整版本后再试。",
                "This build's fullscreen identity files are missing or empty. Install a complete build.",
            ),
            "CERT_FAIL" => pick(
                "证书信任失败。请确认以管理员运行启动器后，再点一次登记。",
                "Couldn't trust the package certificate. Run FantasyHub as admin and register again.",
            ),
            "ADD_FAIL" => pick(
                "系统拒绝了全屏体验包。详情已写入日志（常见原因：能力描述文件 SCCD、证书或系统版本）。",
                "Windows rejected the fullscreen package. Details are in the log (often SCCD, certificate, or OS version).",
            ),
            "SCRIPT_FAIL" => pick(
                "登记脚本无法运行（PowerShell 解析失败）。请安装新版本后再试，并把日志发给开发者。",
                "The register script failed to parse in PowerShell. Install a newer build and share the log.",
            ),
            _ => pick(
                "无法登记到全屏体验。请到设置里点「登记全屏体验」，并把日志发给开发者。",
                "Couldn't register for fullscreen experience. Tap Register in Settings and share the log.",
            ),
        }
    }

    fn clean_fse_status(text: &str) -> Option<String> {
        let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
        let first = lines.next()?.to_string();
        if lines.next().is_some() {
            return None;
        }
        let lower = first.to_lowercase();
        if lower.contains("register-fse.ps1")
            || lower.contains("parsererror")
            || lower.contains("categoryinfo")
            || lower.contains("unexpectedtoken")
            || first.contains('\u{fffd}')
            || first.chars().count() > 120
        {
            return None;
        }
        Some(first)
    }

    fn fse_payload(resource_dir: Option<&std::path::Path>) -> Result<(PathBuf, PathBuf), String> {
        let mut dirs = Vec::new();
        if let Some(dir) = resource_dir {
            dirs.push(dir.join("fse"));
            dirs.push(dir.to_path_buf());
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                dirs.push(parent.join("resources").join("fse"));
                dirs.push(parent.join("fse"));
                dirs.push(parent.join("resources"));
            }
        }
        for dir in dirs {
            let msix = dir.join("identity.msix");
            let cer = dir.join("identity.cer");
            let msix_ok = std::fs::metadata(&msix).map(|m| m.len() > 200).unwrap_or(false);
            let cer_ok = std::fs::metadata(&cer).map(|m| m.len() > 200).unwrap_or(false);
            if msix_ok && cer_ok {
                return Ok((msix, cer));
            }
        }
        Err(pick(
            "安装包里没有全屏体验身份文件。请安装带这个功能的版本。",
            "This build has no fullscreen experience identity. Install a version that includes it.",
        )
        .into())
    }

    pub fn open_fse_settings() -> Result<(), String> {
        let status = hidden(&mut Command::new("cmd.exe"))
            .args(["/C", "start", "", "ms-settings:gaming-fullscreenexperience"])
            .status()
            .map_err(|err| pick(&format!("无法打开设置：{err}"), &format!("Couldn't open settings: {err}")))?;
        if status.success() {
            Ok(())
        } else {
            Err(pick("无法打开全屏体验设置页。", "Couldn't open the fullscreen experience settings page.").into())
        }
    }

    fn enable_login() -> Result<(), String> {
        release_shell();
        write_run_value()?;
        delete_task(OLD_TASK);
        remove_shortcut();
        Ok(())
    }

    fn disable_autostart() {
        release_shell();
        if let Some(dir) = state_dir() {
            let _ = std::fs::remove_file(dir.join("suppress"));
        }
        delete_task(OLD_TASK);
        remove_shortcut();
        clear_run_values();
    }

    /// Winlogon Shell must stay the Windows shell. Replacing it stops Xbox Game Bar and the Xbox button.
    fn release_shell() {
        let was_shell = shell_is_ours();
        if was_shell {
            restore_shell();
        }
        if let Some(dir) = state_dir() {
            let _ = std::fs::remove_file(dir.join("keep-alive"));
            let _ = std::fs::remove_file(dir.join("watch.ps1"));
        }
        delete_task(WATCH_TASK);
        if was_shell {
            start_explorer();
        }
    }

    fn write_run_value() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|err| pick(&format!("无法开启开机自启：{err}"), &format!("Couldn't turn on startup: {err}")))?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(RUN_KEY)
            .map_err(|err| pick(&format!("无法开启开机自启：{err}"), &format!("Couldn't turn on startup: {err}")))?;
        let quoted = format!("\"{}\"", exe.display());
        key.set_value("FantasyHub", &quoted)
            .map_err(|err| pick(&format!("无法开启开机自启：{err}"), &format!("Couldn't turn on startup: {err}")))?;
        let _ = key.delete_value("handheld-launcher");
        Ok(())
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
                .join("FantasyHub.lnk"),
        )
    }

    fn hidden(command: &mut Command) -> &mut Command {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000)
    }

    fn state_dir() -> Option<PathBuf> {
        let appdata = std::env::var_os("APPDATA")?;
        let dir = PathBuf::from(appdata).join("handheld-launcher");
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }

    fn clear_suppress() {
        if let Some(dir) = state_dir() {
            let _ = std::fs::remove_file(dir.join("suppress"));
        }
    }

    fn keep_alive_exists() -> bool {
        state_dir().is_some_and(|dir| dir.join("keep-alive").is_file())
    }

    fn old_launch_exists() -> bool {
        task_exists(OLD_TASK) || task_exists(WATCH_TASK) || shortcut_path().is_some_and(|path| path.is_file()) || run_value_exists()
    }

    fn shell_value() -> Option<String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu.open_subkey_with_flags(SHELL_KEY, KEY_READ).ok()?;
        key.get_value("Shell").ok()
    }

    fn shell_is_ours() -> bool {
        let Some(shell) = shell_value() else {
            return false;
        };
        let shell = shell.to_lowercase();
        if let Ok(exe) = std::env::current_exe() {
            if shell.contains(&exe.display().to_string().to_lowercase()) {
                return true;
            }
        }
        shell.contains("FantasyHub.exe")
    }

    fn set_shell(value: &str) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(SHELL_KEY)
            .map_err(|err| pick(&format!("无法开启开机自启：{err}"), &format!("Couldn't turn on startup: {err}")))?;
        key.set_value("Shell", &value.to_string())
            .map_err(|err| pick(&format!("无法开启开机自启：{err}"), &format!("Couldn't turn on startup: {err}")))
    }

    fn restore_shell() {
        let Some(dir) = state_dir() else {
            return;
        };
        let path = dir.join("previous-shell.txt");
        let previous = std::fs::read_to_string(&path).unwrap_or_else(|_| "*".into());
        let _ = std::fs::remove_file(&path);
        if previous.trim() == "*" {
            if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(SHELL_KEY, KEY_SET_VALUE) {
                let _ = key.delete_value("Shell");
            }
        } else {
            let _ = set_shell(previous.trim());
        }
    }

    fn task_exists(name: &str) -> bool {
        hidden(&mut Command::new("schtasks"))
            .args(["/Query", "/TN", name])
            .output()
            .is_ok_and(|output| output.status.success())
    }

    fn delete_task(name: &str) {
        let _ = hidden(&mut Command::new("schtasks"))
            .args(["/Delete", "/F", "/TN", name])
            .output();
    }

    fn remove_shortcut() {
        if let Some(path) = shortcut_path() {
            if path.is_file() {
                let _ = std::fs::remove_file(path);
            }
        }
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
