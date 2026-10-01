use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static LOG: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 启动器与独立前端写同一个日志文件（按行追加），方便把两边行为放在一条时间线上对照；
/// `tag` 只用来区分是谁启动的。
///
/// 首行带**版本号**：日志里从来没有「这一轮跑的到底是哪一版」，排查浮层时就卡在这儿 ——
/// 同一条 `frontend show end` 在 0.1.47 和 0.1.48 里逐字相同，光看日志分不出这天装的
/// 是不是带修复的那版。两个程序共用这个函数，各报自己编译进去的版本。
pub fn init_for(tag: &str) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut guard) = LOG.lock() {
        *guard = Some(path.clone());
    }
    write_line(&format!(
        "{tag} start pid={} v{}",
        std::process::id(),
        env!("CARGO_PKG_VERSION")
    ));
    #[cfg(windows)]
    {
        let elevated = unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 };
        write_line(&format!("elevated={elevated}"));
    }
}

/// 启动器的入口：日志首行保持 `FantasyHub start pid=... v<版本>`。
pub fn init() {
    init_for("FantasyHub");
}

/// 把 panic 也写进这个日志文件。
///
/// 两个程序都是 GUI（`windows_subsystem = "windows"`，没有控制台），默认的 panic 输出去了
/// stderr —— 在掌机上**谁也看不见**。于是「进程起来两秒后自己没了」在日志里就是一片空白：
/// 0.1.50 真机排查正好卡在这里，前端起来之后一条记录都没有，分不清是「没在跑」「跑着跑着
/// 崩了」还是「按键没进来」这三种完全不同的情况。
///
/// 装一次就够（两个程序各在自己的 `main` 里装）。**哪个线程、哪一行、panic 原文**都会留下
/// 一行 `panic (…)`，之后照旧交给默认钩子：stderr 行为不变，debug 下照样有完整回溯。
///
/// `tag` 用 `'static`：钩子是全局的，活到进程结束，借用的字符串必须先静态化。
pub fn install_panic_hook(tag: &'static str) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let thread = std::thread::current()
            .name()
            .map(str::to_string)
            .unwrap_or_else(|| "unnamed".to_string());
        write_line(&format!(
            "{tag} panic ({location}, thread={thread}): {info}"
        ));
        previous(info);
    }));
}

/// 现场文件目录（`%APPDATA%\handheld-launcher`，非 Windows 是临时目录）：
/// 日志在这里，浮层的截图也写这里 —— 让用户一次就能把整份现场一起拷回来。
pub fn dir() -> PathBuf {
    state_dir()
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

fn state_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("handheld-launcher");
        }
    }
    std::env::temp_dir()
}

fn log_path() -> PathBuf {
    state_dir().join("fantasyhub.log")
}

fn chrono_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}
