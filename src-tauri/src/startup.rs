use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use tauri::Manager;

static QUIT_ALLOWED: AtomicBool = AtomicBool::new(false);

pub fn quit_allowed() -> bool {
    QUIT_ALLOWED.load(Ordering::SeqCst)
}

/// User chose 退出. The watcher must not start another copy until the next sign-in.
pub fn request_quit() {
    QUIT_ALLOWED.store(true, Ordering::SeqCst);
    #[cfg(windows)]
    windows::hold_until_next_sign_in();
}

#[tauri::command]
pub fn quit_launcher(app: tauri::AppHandle) {
    request_quit();
    app.exit(0);
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
    Err("只能在 Windows 上打开桌面".into())
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
    "只能在 Windows 上登记全屏体验。".into()
}

#[tauri::command]
pub fn register_fse(app: tauri::AppHandle) -> String {
    #[cfg(windows)]
    {
        let dir = app.path().resource_dir().ok();
        return windows::register_fse(dir.as_deref());
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        "只能在 Windows 上登记全屏体验。".into()
    }
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
        Err("只能在 Windows 上设置开机自启".into())
    }
}

/// Keep a previous opt-in, and drop the "do not restart" mark from an earlier quit.
pub fn prepare() {
    #[cfg(windows)]
    windows::prepare();
}

#[cfg(windows)]
mod windows {
    use std::path::PathBuf;
    use std::process::Command;

    const RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    const APPROVED_KEY: &str =
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
    const RUN_NAMES: [&str; 2] = ["handheld-launcher", "Handheld Launcher"];

    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    const WATCH_TASK: &str = "Handheld Launcher Watch";
    const OLD_TASK: &str = "Handheld Launcher";
    const SHELL_KEY: &str = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon";

    pub fn enabled() -> bool {
        shell_is_ours()
    }

    pub fn set_enabled(enabled: bool) -> Result<(), String> {
        if enabled {
            enable_shell()?;
        } else {
            disable_shell();
        }
        Ok(())
    }

    pub fn prepare() {
        clear_suppress();
        if !shell_is_ours() && !keep_alive_exists() && !old_launch_exists() {
            return;
        }
        let _ = enable_shell();
    }

    pub fn hold_until_next_sign_in() {
        if let Some(dir) = state_dir() {
            let _ = std::fs::write(dir.join("suppress"), "");
        }
        start_explorer();
    }

    pub fn start_explorer() {
        let _ = Command::new("explorer.exe").spawn();
    }

    const REGISTER_PS1: &str = include_str!("../fse/register.ps1");

    pub fn schedule_fse_registration(resource_dir: Option<std::path::PathBuf>) {
        std::thread::spawn(move || {
            let _ = register_fse(resource_dir.as_deref());
        });
    }

    pub fn fse_status() -> String {
        state_dir()
            .and_then(|dir| std::fs::read_to_string(dir.join("fse-status.txt")).ok())
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "还没有登记到全屏体验。".into())
    }

    pub fn register_fse(resource_dir: Option<&std::path::Path>) -> String {
        let result = match register_fse_inner(resource_dir) {
            Ok(text) => text,
            Err(text) => text,
        };
        if let Some(dir) = state_dir() {
            let _ = std::fs::write(dir.join("fse-status.txt"), &result);
        }
        result
    }

    fn register_fse_inner(resource_dir: Option<&std::path::Path>) -> Result<String, String> {
        let (msix, cer) = fse_payload(resource_dir)?;
        let exe = std::env::current_exe().map_err(|err| format!("无法登记：{err}"))?;
        let exe_dir = exe.parent().ok_or("无法登记：找不到安装目录")?;
        let exe_name = exe
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("无法登记：程序名不能用")?;
        let dir = state_dir().ok_or("无法登记：找不到数据目录")?;
        let script = dir.join("register-fse.ps1");
        std::fs::write(&script, REGISTER_PS1).map_err(|err| format!("无法登记：{err}"))?;
        let output = hidden(&mut Command::new("powershell.exe"))
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .arg("-Msix")
            .arg(&msix)
            .arg("-Cer")
            .arg(&cer)
            .arg("-ExeDir")
            .arg(exe_dir)
            .arg("-ExeName")
            .arg(exe_name)
            .output()
            .map_err(|err| format!("无法登记：{err}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.success() {
            return Ok(stdout
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("已登记。")
                .trim()
                .to_string());
        }
        let detail = format!("{}{}", stdout.trim(), stderr.trim());
        Err(if detail.is_empty() {
            "无法登记到全屏体验。".into()
        } else {
            format!("无法登记：{detail}")
        })
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
            if msix.is_file() && cer.is_file() {
                return Ok((msix, cer));
            }
        }
        Err("安装包里没有全屏体验身份文件。请安装带这个功能的版本。".into())
    }

    fn enable_shell() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|err| format!("无法开启开机自启：{err}"))?;
        remember_shell();
        set_shell(&format!("\"{}\"", exe.display()))?;
        let dir = state_dir().ok_or("无法开启开机自启：找不到数据目录")?;
        std::fs::write(dir.join("keep-alive"), exe.display().to_string())
            .map_err(|err| format!("无法开启开机自启：{err}"))?;
        let _ = std::fs::remove_file(dir.join("suppress"));
        write_watch_script(&dir)?;
        write_watch_task(&dir)?;
        spawn_watcher();
        delete_task(OLD_TASK);
        remove_shortcut();
        clear_run_values();
        Ok(())
    }

    fn disable_shell() {
        restore_shell();
        if let Some(dir) = state_dir() {
            let _ = std::fs::remove_file(dir.join("keep-alive"));
            let _ = std::fs::remove_file(dir.join("suppress"));
            let _ = std::fs::remove_file(dir.join("watch.ps1"));
        }
        delete_task(WATCH_TASK);
        delete_task(OLD_TASK);
        remove_shortcut();
        clear_run_values();
        start_explorer();
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
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let Some(shell) = shell_value() else {
            return false;
        };
        shell.to_lowercase().contains(&exe.display().to_string().to_lowercase())
    }

    fn remember_shell() {
        if shell_is_ours() {
            return;
        }
        let Some(dir) = state_dir() else {
            return;
        };
        let previous = shell_value().unwrap_or_else(|| "*".into());
        let _ = std::fs::write(dir.join("previous-shell.txt"), previous);
    }

    fn set_shell(value: &str) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(SHELL_KEY)
            .map_err(|err| format!("无法开启开机自启：{err}"))?;
        key.set_value("Shell", &value.to_string())
            .map_err(|err| format!("无法开启开机自启：{err}"))
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

    fn write_watch_script(dir: &std::path::Path) -> Result<(), String> {
        let script = r#"$root = Join-Path $env:APPDATA 'handheld-launcher'
$flag = Join-Path $root 'keep-alive'
$suppress = Join-Path $root 'suppress'
$mutex = New-Object System.Threading.Mutex($false, 'Local\HandheldLauncherWatch')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  while (Test-Path -LiteralPath $flag) {
    if (Test-Path -LiteralPath $suppress) { Start-Sleep -Seconds 3; continue }
    $exe = (Get-Content -LiteralPath $flag -Raw).Trim()
    if (-not $exe) { Start-Sleep -Seconds 3; continue }
    $name = [IO.Path]::GetFileName($exe).Replace("'", "''")
    $running = Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -eq $exe }
    if (-not $running) { Start-Process -FilePath $exe }
    Start-Sleep -Seconds 3
  }
} finally { $mutex.ReleaseMutex() | Out-Null }
"#;
        std::fs::write(dir.join("watch.ps1"), script).map_err(|err| format!("无法开启开机自启：{err}"))
    }

    fn write_watch_task(dir: &std::path::Path) -> Result<(), String> {
        let script = dir.join("watch.ps1");
        let run = format!(
            "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        );
        let output = hidden(&mut Command::new("schtasks"))
            .args(["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", WATCH_TASK, "/TR", &run])
            .output()
            .map_err(|err| format!("无法开启开机自启：{err}"))?;
        if output.status.success() {
            return Ok(());
        }
        let err = String::from_utf8_lossy(&output.stderr);
        Err(format!("无法开启开机自启：{err}"))
    }

    fn spawn_watcher() {
        let Some(dir) = state_dir() else {
            return;
        };
        let script = dir.join("watch.ps1");
        if !script.is_file() {
            return;
        }
        let _ = hidden(&mut Command::new("powershell.exe"))
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .spawn();
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
