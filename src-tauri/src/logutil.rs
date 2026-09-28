use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static LOG: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init() {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut guard) = LOG.lock() {
        *guard = Some(path.clone());
    }
    write_line(&format!("FantasyHub start pid={}", std::process::id()));
    #[cfg(windows)]
    {
        let elevated = unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 };
        write_line(&format!("elevated={elevated}"));
    }
}

pub fn write_line(message: &str) {
    let stamp = chrono_stamp();
    let line = format!("[{stamp}] {message}\n");
    eprintln!("{message}");
    let path = LOG
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(log_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

pub fn path_for_user() -> String {
    log_path().to_string_lossy().into_owned()
}

fn log_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata)
                .join("handheld-launcher")
                .join("fantasyhub.log");
        }
    }
    std::env::temp_dir().join("fantasyhub.log")
}

fn chrono_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}
