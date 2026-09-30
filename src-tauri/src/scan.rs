use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
#[cfg(windows)]
use std::collections::{HashMap, HashSet};
#[cfg(windows)]
use std::path::{Path, PathBuf};

use crate::i18n::pick;

/// Shell is tucked (hidden) so a game / other app can keep focus under FSE.
static AWAY_SESSION: AtomicBool = AtomicBool::new(false);
/// While set, FSE may force-focus us — re-hide instead of filling the screen.
static AWAY_SUPPRESS_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static RECENT_LAUNCHES: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|dur| u64::try_from(dur.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub fn away_session_active() -> bool {
    AWAY_SESSION.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn away_suppress_active() -> bool {
    unix_ms() < AWAY_SUPPRESS_UNTIL.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn clear_away_session() {
    AWAY_SESSION.store(false, std::sync::atomic::Ordering::Relaxed);
    AWAY_SUPPRESS_UNTIL.store(0, std::sync::atomic::Ordering::Relaxed);
}

/// Leave exclusive fullscreen and hide — never minimize under FSE (it snaps back and steals focus).
#[cfg(windows)]
pub fn begin_away_session(app: &tauri::AppHandle) {
    leave_fullscreen(app);
    if let Some(window) = launcher_window(app) {
        let _ = window.hide();
    }
    AWAY_SESSION.store(true, std::sync::atomic::Ordering::Relaxed);
    AWAY_SUPPRESS_UNTIL.store(
        unix_ms().saturating_add(3000),
        std::sync::atomic::Ordering::Relaxed,
    );
    crate::logutil::write_line("away session: hide shell (no minimize)");
}

#[cfg(windows)]
pub fn restore_shell(app: &tauri::AppHandle) {
    clear_away_session();
    if let Some(window) = launcher_window(app) {
        crate::startup::fill_screen(&window);
    }
}

/// FSE forced focus during launch suppress — tuck again so the game keeps the foreground.
pub fn rehide_shell_if_away(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        if !away_session_active() {
            return;
        }
        if let Some(window) = launcher_window(app) {
            let _ = window.hide();
            crate::logutil::write_line("away session: re-hide after FSE focus");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// Watch the process we just yielded to and bring the shell back when it exits.
/// The shell hides itself on launch and fullscreen / FSE offers no task list, so
/// without this the user would quit the game onto a bare desktop. Only a game we
/// have actually seen running may "disappear" — a slow first start, a launcher
/// hand-off or a level reload must never pop the library back over the game.
#[cfg(windows)]
pub fn watch_game_exit(app: &tauri::AppHandle, launch_path: &str, install_path: &str) {
    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let launch_path = launch_path.to_string();
    let install_path = install_path.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut seen_running = false;
        let mut missing = 0u32;
        let started = std::time::Instant::now();
        // Bounded so a broken probe cannot leave a thread polling forever.
        while started.elapsed() < std::time::Duration::from_secs(8 * 60 * 60) {
            std::thread::sleep(std::time::Duration::from_millis(2000));
            // User came back on their own, or the app is quitting.
            if crate::startup::quit_allowed() || !away_session_active() {
                break;
            }
            match windows::activate_game(&launch_path, &install_path) {
                GamePresence::Absent => {
                    if seen_running {
                        missing = missing.saturating_add(1);
                        if missing >= 2 {
                            crate::logutil::write_line("game exited: reveal shell");
                            crate::reveal_shell(&app);
                            break;
                        }
                    }
                }
                GamePresence::Focused | GamePresence::Running => {
                    seen_running = true;
                    missing = 0;
                }
            }
        }
        WATCHING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedGame {
    pub id: String,
    pub name: String,
    pub cover: String,
    pub cover_path: String,
    pub install_path: String,
    pub launch_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedApp {
    pub id: String,
    pub name: String,
    pub icon_path: String,
    pub install_path: String,
    pub launch_path: String,
}

#[tauri::command]
pub fn scan_games(app: tauri::AppHandle) -> Vec<ScannedGame> {
    #[cfg(windows)]
    {
        return windows::scan_games(&app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Vec::new()
    }
}

#[tauri::command]
pub fn scan_apps(app: tauri::AppHandle) -> Vec<ScannedApp> {
    #[cfg(windows)]
    {
        return windows::scan_apps(&app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Vec::new()
    }
}

#[tauri::command]
pub fn cache_covers(
    app: tauri::AppHandle,
    covers: Vec<crate::media::CoverRequest>,
) -> Vec<crate::media::CachedCover> {
    crate::media::cache_remote_covers(&app, covers)
}

#[tauri::command]
pub fn steam_library_cover(app_id: String) -> Result<String, String> {
    crate::media::fetch_steam_library_cover(&app_id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningQuery {
    pub id: String,
    #[serde(default)]
    pub launch_path: String,
    #[serde(default)]
    pub install_path: String,
}

enum GamePresence {
    Absent,
    Running,
    Focused,
}

#[tauri::command]
pub fn running_games(items: Vec<RunningQuery>) -> Vec<String> {
    #[cfg(windows)]
    {
        return windows::running_ids(&items);
    }
    #[cfg(not(windows))]
    {
        let _ = items;
        Vec::new()
    }
}

#[tauri::command]
pub fn quit_game(id: String, launch_path: String, install_path: String) -> Result<u32, String> {
    #[cfg(windows)]
    {
        let killed = windows::kill_game(&launch_path, &install_path);
        forget_launch(&id);
        if killed == 0 {
            return Err(pick(
                "没有找到正在运行的游戏进程",
                "No running process was found for that game.",
            )
            .into());
        }
        Ok(killed)
    }
    #[cfg(not(windows))]
    {
        let _ = (id, launch_path, install_path);
        Err(pick("只能在 Windows 上退出游戏", "Quitting games only works on Windows.").into())
    }
}

#[tauri::command]
pub fn launch_item(
    app: tauri::AppHandle,
    id: String,
    launch_path: String,
    install_path: String,
    switch_if_running: Option<bool>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        if switch_if_running.unwrap_or(false) {
            match windows::activate_game(&launch_path, &install_path) {
                GamePresence::Absent if launched_recently(&id) => return Ok("running".into()),
                GamePresence::Absent => {}
                GamePresence::Focused | GamePresence::Running => {
                    let switched = windows::reveal_game(&id, &launch_path, &install_path);
                    // Only yield the shell once the game really owns the screen. Under
                    // fullscreen / FSE a hidden shell has no task list to come back from,
                    // so a switch that failed must leave the library where it is.
                    if switched {
                        begin_away_session(&app);
                        watch_game_exit(&app, &launch_path, &install_path);
                    }
                    return Ok(if switched { "focused".into() } else { "running".into() });
                }
            }
        }
        // Hide (not minimize) — FSE restores minimized windows and steals focus back.
        begin_away_session(&app);
        if let Err(err) = windows::launch(&id, &launch_path, &install_path) {
            restore_shell(&app);
            return Err(err);
        }
        remember_launch(&id);
        // The shell just hid itself and FSE has no task list, so watch the game for us.
        watch_game_exit(&app, &launch_path, &install_path);
        return Ok("launched".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, launch_path, install_path, switch_if_running);
        Err(pick("只能在 Windows 上启动", "Launching only works on Windows.").into())
    }
}

/// Bring the library back after a game (or another app) took the screen.
/// The floating overlay calls this from its 「回到启动器」 row; desktop mode can
/// use it too. It is also the recovery path when nothing else is reachable.
#[tauri::command]
pub fn reveal_launcher(app: tauri::AppHandle) {
    crate::reveal_shell(&app);
}

#[cfg(windows)]
fn launcher_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    use tauri::Manager;
    app.get_webview_window("main")
}

#[cfg(windows)]
fn leave_fullscreen(app: &tauri::AppHandle) {
    if let Some(window) = launcher_window(app) {
        let _ = window.set_fullscreen(false);
    }
}

/// Steam and Epic ids become launcher URLs. Anything else is started from its exe.
fn is_scanned_game(key: &str, install: &str, icon: &str, uninstall: &str, epic_dirs: &[String]) -> bool {
    if key.to_ascii_lowercase().starts_with("steam app ") {
        return true;
    }
    let paths = [install, icon, uninstall];
    if paths.iter().any(|path| {
        let lower = path.replace('/', "\\").to_ascii_lowercase();
        lower.contains("steam://uninstall") || lower.contains("\\steamapps\\common\\")
    }) {
        return true;
    }
    paths.iter().any(|path| {
        epic_dirs.iter().any(|dir| path_under(path, dir))
    })
}

fn path_under(path: &str, dir: &str) -> bool {
    let path = path
        .replace('/', "\\")
        .trim()
        .trim_matches('"')
        .to_ascii_lowercase();
    let dir = dir
        .replace('/', "\\")
        .trim()
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    !path.is_empty() && !dir.is_empty() && (path == dir || path.starts_with(&format!("{dir}\\")))
}

fn protocol_url(id: &str) -> Option<String> {
    if let Some(appid) = id.strip_prefix("steam:") {
        if !appid.is_empty() && appid.chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("steam://rungameid/{appid}"));
        }
        return None;
    }
    if let Some(app) = id.strip_prefix("epic:") {
        let safe = !app.is_empty()
            && app
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        if safe {
            return Some(format!("com.epicgames.launcher://apps/{app}?action=launch"));
        }
    }
    None
}

fn remember_launch(id: &str) {
    if id.is_empty() {
        return;
    }
    let now = unix_ms();
    let mut list = RECENT_LAUNCHES.lock().unwrap_or_else(|err| err.into_inner());
    list.retain(|(_, at)| now.saturating_sub(*at) < 8_000);
    list.push((id.to_string(), now));
}

fn forget_launch(id: &str) {
    if id.is_empty() {
        return;
    }
    let mut list = RECENT_LAUNCHES.lock().unwrap_or_else(|err| err.into_inner());
    list.retain(|(key, _)| key != id);
}

fn launched_recently(id: &str) -> bool {
    if id.is_empty() {
        return false;
    }
    let now = unix_ms();
    let list = RECENT_LAUNCHES.lock().unwrap_or_else(|err| err.into_inner());
    list.iter().any(|(key, at)| key == id && now.saturating_sub(*at) < 8_000)
}

fn normalize_win_path(path: &str) -> String {
    path.replace('/', "\\").trim().trim_end_matches('\\').to_ascii_lowercase()
}

fn usable_game_root(path: &str) -> Option<String> {
    let norm = normalize_win_path(path);
    let rest = norm.split_once('\\').map(|(_, tail)| tail).unwrap_or("");
    let parts: Vec<&str> = rest.split('\\').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    const GENERIC: &[&str] = &[
        "program files",
        "program files (x86)",
        "windows",
        "users",
        "steam",
        "steamapps",
        "common",
        "games",
        "desktop",
        "downloads",
    ];
    if parts.last().is_some_and(|part| GENERIC.contains(part)) {
        return None;
    }
    Some(norm)
}

fn process_belongs_to_game(launch_path: &str, install_path: &str, process_path: &str) -> bool {
    let process = normalize_win_path(process_path);
    if process.is_empty() {
        return false;
    }
    let launch = normalize_win_path(launch_path);
    if !launch.is_empty() && process == launch {
        return true;
    }
    let file = process.rsplit('\\').next().unwrap_or("");
    const HELPERS: &[&str] = &[
        "steam.exe",
        "steamwebhelper.exe",
        "steamservice.exe",
        "steamerrorreporter.exe",
        "gameoverlayui.exe",
        "epicgameslauncher.exe",
        "epicwebhelper.exe",
        "explorer.exe",
    ];
    if HELPERS.contains(&file) {
        return false;
    }
    let under = |root: &str| process == root || process.starts_with(&format!("{root}\\"));
    if let Some(root) = usable_game_root(install_path) {
        if under(&root) {
            return true;
        }
    }
    if let Some(parent) = launch.rsplit_once('\\').map(|(dir, _)| dir) {
        if let Some(root) = usable_game_root(parent) {
            if under(&root) {
                return true;
            }
        }
    }
    // Anti-cheat processes often refuse a full path query. The snapshot still has the exe name.
    if !process.contains('\\') {
        let launch_file = launch.rsplit('\\').next().unwrap_or("");
        return !launch_file.is_empty() && file == launch_file;
    }
    false
}

#[derive(Debug, PartialEq, Eq)]
struct AcfGame {
    appid: String,
    name: String,
    installdir: String,
    fully_installed: bool,
}

fn next_quoted(text: &str, start: usize) -> Option<(String, usize)> {
    let rest = text.get(start..)?;
    let open = rest.find('"')?;
    let mut i = start + open + 1;
    let bytes = text.as_bytes();
    let mut out = String::new();
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            let escaped = text[i + 1..].chars().next()?;
            out.push(escaped);
            i += 1 + escaped.len_utf8();
            continue;
        }
        if bytes[i] == b'"' {
            return Some((out, i + 1));
        }
        let ch = text[i..].chars().next()?;
        out.push(ch);
        i += ch.len_utf8();
    }
    None
}

fn vdf_pairs(text: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut i = 0;
    while let Some((key, next)) = next_quoted(text, i) {
        let trimmed = next + (text[next..].len() - text[next..].trim_start().len());
        if text[trimmed..].starts_with('"') {
            if let Some((value, end)) = next_quoted(text, trimmed) {
                pairs.push((key, value));
                i = end;
                continue;
            }
        }
        i = next;
    }
    pairs
}

fn looks_like_windows_path(value: &str) -> bool {
    let v = value.trim();
    let bytes = v.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || v.starts_with(r"\\")
}

fn library_roots_from_vdf(text: &str) -> Vec<String> {
    vdf_pairs(text)
        .into_iter()
        .filter_map(|(key, value)| {
            if key.eq_ignore_ascii_case("path") && looks_like_windows_path(&value) {
                return Some(value);
            }
            if key.chars().all(|c| c.is_ascii_digit()) && looks_like_windows_path(&value) {
                return Some(value);
            }
            None
        })
        .collect()
}

fn parse_acf(text: &str) -> Option<AcfGame> {
    let mut appid = String::new();
    let mut name = String::new();
    let mut installdir = String::new();
    let mut flags: Option<u32> = None;
    for (key, value) in vdf_pairs(text) {
        if key.eq_ignore_ascii_case("appid") {
            appid = value;
        } else if key.eq_ignore_ascii_case("name") {
            name = value;
        } else if key.eq_ignore_ascii_case("installdir") {
            installdir = value;
        } else if key.eq_ignore_ascii_case("stateflags") {
            flags = value.parse().ok();
        }
    }
    if appid.is_empty() || installdir.is_empty() {
        return None;
    }
    if name.is_empty() {
        name = installdir.clone();
    }
    let fully_installed = flags.map(|n| n & 4 != 0).unwrap_or(true);
    Some(AcfGame {
        appid,
        name,
        installdir,
        fully_installed,
    })
}

fn is_steam_tool(appid: &str, name: &str) -> bool {
    appid == "228980" || name.to_ascii_lowercase().contains("redistributable")
}

#[cfg(windows)]
fn steam_cover(appid: &str) -> String {
    format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg")
}

fn clean_reg_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let mut s = if let Some(rest) = trimmed.strip_prefix('"') {
        rest.split_once('"')
            .map(|(path, _)| path.to_string())
            .unwrap_or_else(|| rest.to_string())
    } else {
        trimmed.to_string()
    };
    if let Some(idx) = s.rfind(',') {
        let tail = &s[idx + 1..];
        if !tail.is_empty()
            && tail.chars().all(|c| c.is_ascii_digit())
            && s[..idx].to_ascii_lowercase().ends_with(".exe")
        {
            s.truncate(idx);
        }
    }
    s
}

fn is_noise_app(name: &str, system_component: u32, release_type: &str, parent: &str) -> bool {
    if name.trim().is_empty()
        || system_component == 1
        || !release_type.is_empty()
        || !parent.is_empty()
    {
        return true;
    }
    let lower = name.to_lowercase();
    if lower.starts_with("update for ")
        || lower.ends_with(" update")
        || lower.ends_with(" updater")
        || lower.contains(" updater")
    {
        return true;
    }
    const NOISE: &[&str] = &[
        "visual c++",
        "microsoft .net",
        ".net runtime",
        ".net host",
        ".net core",
        "windows desktop runtime",
        "webview2",
        "windows sdk",
        "windows software development kit",
        "security update",
        "hotfix",
    ];
    NOISE.iter().any(|part| lower.contains(part))
}

#[cfg(windows)]
fn skip_exe_name(stem: &str) -> bool {
    let lower = stem.to_ascii_lowercase();
    const SKIP: &[&str] = &[
        "uninstall",
        "unins000",
        "unitycrashhandler",
        "crashreporter",
        "crashpad_handler",
        "vc_redist",
        "setup",
        "redist",
        "dxsetup",
        "dotnet",
        "install",
    ];
    SKIP.iter()
        .any(|name| lower == *name || lower.contains("uninstall"))
}

#[cfg(windows)]
fn pick_launch_exe(install_dir: &Path, game_name: &str) -> String {
    let mut candidates = Vec::new();
    push_exes(install_dir, &mut candidates);
    if candidates.is_empty() {
        let entries = match std::fs::read_dir(install_dir) {
            Ok(entries) => entries,
            Err(_) => return String::new(),
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => continue,
            };
            if !file_type.is_dir() {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if matches!(
                folder.as_str(),
                "redist"
                    | "_commonredist"
                    | "directx"
                    | "dotnet"
                    | "engine"
                    | "support"
                    | "crashpad"
            ) {
                continue;
            }
            push_exes(&entry.path(), &mut candidates);
        }
    }
    if candidates.is_empty() {
        return String::new();
    }
    let folded: String = game_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    candidates.sort_by(|a, b| score_exe(b, &folded).cmp(&score_exe(a, &folded)));
    candidates
        .first()
        .map(|path| path.display().to_string())
        .unwrap_or_default()
}

#[cfg(windows)]
fn push_exes(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten().take(80) {
        let path = entry.path();
        let Some(ext) = path.extension() else {
            continue;
        };
        if !ext.eq_ignore_ascii_case("exe") {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if skip_exe_name(&stem) {
            continue;
        }
        out.push(path);
    }
}

#[cfg(windows)]
fn score_exe(path: &Path, folded_name: &str) -> i32 {
    let stem: String = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if !stem.is_empty()
        && !folded_name.is_empty()
        && (folded_name.contains(&stem) || stem.contains(folded_name))
    {
        100
    } else {
        1
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::process::CommandExt;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    pub fn running_ids(items: &[RunningQuery]) -> Vec<String> {
        let processes = process_paths();
        items
            .iter()
            .filter(|item| {
                processes
                    .iter()
                    .any(|(_, path)| process_belongs_to_game(&item.launch_path, &item.install_path, path))
            })
            .map(|item| item.id.clone())
            .collect()
    }

    pub fn activate_game(launch_path: &str, install_path: &str) -> GamePresence {
        let pids = game_pids(launch_path, install_path);
        if pids.is_empty() {
            return GamePresence::Absent;
        }
        if game_window(&pids).is_some() {
            GamePresence::Focused
        } else {
            GamePresence::Running
        }
    }

    pub fn reveal_game(id: &str, launch_path: &str, install_path: &str) -> bool {
        let pids = game_pids(launch_path, install_path);
        let mut switched = false;
        if let Some(hwnd) = game_window(&pids) {
            focus_window(hwnd);
            switched = true;
        }
        // Steam / Epic will foreground an already-running title when asked to launch again.
        if let Some(url) = protocol_url(id) {
            if shell_open(&url).is_ok() {
                switched = true;
            }
        }
        switched
    }

    pub fn kill_game(launch_path: &str, install_path: &str) -> u32 {
        let mut killed = 0u32;
        for pid in game_pids(launch_path, install_path) {
            if terminate_pid(pid) {
                killed = killed.saturating_add(1);
            }
        }
        killed
    }

    fn terminate_pid(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        if pid == 0 {
            return false;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if handle.is_null() {
                return false;
            }
            let ok = TerminateProcess(handle, 1) != 0;
            CloseHandle(handle);
            ok
        }
    }

    fn game_pids(launch_path: &str, install_path: &str) -> Vec<u32> {
        process_paths()
            .into_iter()
            .filter(|(_, path)| process_belongs_to_game(launch_path, install_path, path))
            .map(|(pid, _)| pid)
            .collect()
    }

    fn process_paths() -> Vec<(u32, String)> {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
        };

        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap.is_null() || snap == INVALID_HANDLE_VALUE {
                return Vec::new();
            }
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut found = Vec::new();
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    let pid = entry.th32ProcessID;
                    if let Some(path) = image_path(pid) {
                        found.push((pid, path));
                    } else {
                        let end = entry
                            .szExeFile
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(entry.szExeFile.len());
                        let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                        if !name.is_empty() {
                            found.push((pid, name));
                        }
                    }
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
            found
        }
    }

    fn image_path(pid: u32) -> Option<String> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        if pid == 0 {
            return None;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if ok == 0 || len == 0 {
                return None;
            }
            let end = (len as usize).min(buf.len());
            Some(String::from_utf16_lossy(&buf[..end]))
        }
    }

    fn game_window(pids: &[u32]) -> Option<windows_sys::Win32::Foundation::HWND> {
        use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic,
            IsWindowVisible, GW_OWNER, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
        };

        struct Pick {
            pids: Vec<u32>,
            hwnd: HWND,
            area: i64,
        }
        unsafe extern "system" fn each(hwnd: HWND, param: LPARAM) -> i32 {
            let pick = &mut *(param as *mut Pick);
            if hwnd.is_null() || !GetWindow(hwnd, GW_OWNER).is_null() {
                return 1;
            }
            let visible = IsWindowVisible(hwnd) != 0;
            let iconic = IsIconic(hwnd) != 0;
            if !visible && !iconic {
                return 1;
            }
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW != 0 {
                return 1;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if !pick.pids.contains(&pid) {
                return 1;
            }
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return 1;
            }
            let area = i64::from(rect.right.saturating_sub(rect.left))
                * i64::from(rect.bottom.saturating_sub(rect.top));
            let score = if iconic && area <= 0 { 1 } else { area };
            if score > pick.area {
                pick.hwnd = hwnd;
                pick.area = score;
            }
            1
        }
        let mut pick = Pick {
            pids: pids.to_vec(),
            hwnd: std::ptr::null_mut(),
            area: 0,
        };
        unsafe {
            EnumWindows(Some(each), &mut pick as *mut Pick as LPARAM);
        }
        (!pick.hwnd.is_null() && pick.area > 0).then_some(pick.hwnd)
    }

    fn focus_window(hwnd: windows_sys::Win32::Foundation::HWND) {
        use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            keybd_event, SetActiveWindow, KEYEVENTF_KEYUP, VK_MENU,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            AllowSetForegroundWindow, BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
            SetForegroundWindow, SetWindowPos, ShowWindow, ASFW_ANY, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE,
            SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE, SW_SHOW,
        };
        unsafe {
            AllowSetForegroundWindow(ASFW_ANY);
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            } else {
                ShowWindow(hwnd, SW_SHOW);
            }
            // Unlock the foreground lock; Windows blocks SetForegroundWindow without this.
            keybd_event(VK_MENU as u8, 0, 0, 0);
            keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
            let foreground = GetForegroundWindow();
            let foreground_thread = GetWindowThreadProcessId(foreground, std::ptr::null_mut());
            let target_thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
            let current = GetCurrentThreadId();
            let attach_foreground = foreground_thread != 0
                && foreground_thread != current
                && AttachThreadInput(current, foreground_thread, 1) != 0;
            let attach_target = target_thread != 0
                && target_thread != current
                && target_thread != foreground_thread
                && AttachThreadInput(current, target_thread, 1) != 0;
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            SetActiveWindow(hwnd);
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
            SetWindowPos(
                hwnd,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
            if attach_target {
                AttachThreadInput(current, target_thread, 0);
            }
            if attach_foreground {
                AttachThreadInput(current, foreground_thread, 0);
            }
        }
    }

    pub fn launch(id: &str, launch_path: &str, install_path: &str) -> Result<(), String> {
        if id.starts_with("steam:") {
            let url = protocol_url(id).ok_or_else(|| pick("无效的 Steam 游戏", "That Steam game isn't valid."))?;
            return shell_open(&url);
        }
        if let Some(url) = protocol_url(id) {
            return shell_open(&url);
        }
        spawn_exe(launch_path, install_path)
    }

    fn shell_open(target: &str) -> Result<(), String> {
        if target
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '&' | '|'))
        {
            return Err(pick("无效的启动地址", "That launch address isn't valid."));
        }
        std::process::Command::new("cmd")
            .args(["/C", "start", "", target])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| pick(&format!("无法启动：{err}"), &format!("Couldn't launch: {err}")))?;
        Ok(())
    }

    fn spawn_exe(launch_path: &str, install_path: &str) -> Result<(), String> {
        let path = PathBuf::from(launch_path.trim());
        let is_exe = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
        if !path.is_file() || !is_exe {
            return Err(pick("没有可启动的程序", "There's nothing to launch."));
        }
        let cwd = path
            .parent()
            .filter(|dir| dir.is_dir())
            .map(Path::to_path_buf)
            .or_else(|| {
                let install = PathBuf::from(install_path.trim());
                install.is_dir().then_some(install)
            });
        let mut cmd = std::process::Command::new(&path);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.spawn().map_err(|err| pick(&format!("无法启动：{err}"), &format!("Couldn't launch: {err}")))?;
        Ok(())
    }

    pub fn scan_games(app: &tauri::AppHandle) -> Vec<ScannedGame> {
        let roots = steam_roots();
        let mut games = Vec::new();
        let mut seen = HashSet::new();
        for root in &roots {
            for library in steam_libraries(root) {
                scan_steam_library(&library, &mut games, &mut seen);
            }
        }
        scan_epic(&mut games, &mut seen);
        for game in &mut games {
            if let Some(appid) = game.id.strip_prefix("steam:") {
                let local = crate::media::local_steam_cover(app, &roots, appid);
                if !local.is_empty() {
                    game.cover_path = local;
                    // Keep the CDN URL so the UI can fall back if the local file is missing.
                }
            }
        }
        games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        games
    }

    pub fn scan_apps(app: &tauri::AppHandle) -> Vec<ScannedApp> {
        let epic_dirs = epic_install_dirs();
        let mut found = HashMap::new();
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        read_uninstall(
            app,
            &hklm,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            "hklm",
            &epic_dirs,
            &mut found,
        );
        read_uninstall(
            app,
            &hklm,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            "hklm32",
            &epic_dirs,
            &mut found,
        );
        read_uninstall(
            app,
            &hkcu,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            "hkcu",
            &epic_dirs,
            &mut found,
        );
        let mut apps: Vec<ScannedApp> = found.into_values().collect();
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        apps
    }

    fn steam_roots() -> Vec<PathBuf> {
        let mut roots = Vec::new();
        push_reg_path(
            HKEY_CURRENT_USER,
            r"Software\Valve\Steam",
            "SteamPath",
            &mut roots,
        );
        push_reg_path(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Valve\Steam",
            "InstallPath",
            &mut roots,
        );
        push_reg_path(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Valve\Steam",
            "InstallPath",
            &mut roots,
        );
        dedupe_paths(roots)
    }

    fn push_reg_path(hive: winreg::HKEY, subkey: &str, value: &str, out: &mut Vec<PathBuf>) {
        let root = RegKey::predef(hive);
        let Ok(key) = root.open_subkey(subkey) else {
            return;
        };
        let Ok(path) = key.get_value::<String, _>(value) else {
            return;
        };
        let path = path.trim().trim_matches('"').to_string();
        if !path.is_empty() {
            out.push(PathBuf::from(path));
        }
    }

    fn steam_libraries(steam_root: &Path) -> Vec<PathBuf> {
        let mut roots = vec![steam_root.to_path_buf()];
        for relative in ["steamapps/libraryfolders.vdf", "config/libraryfolders.vdf"] {
            let path = steam_root.join(relative);
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            for library in library_roots_from_vdf(&text) {
                roots.push(PathBuf::from(library));
            }
        }
        dedupe_paths(roots)
    }

    fn scan_steam_library(
        library: &Path,
        games: &mut Vec<ScannedGame>,
        seen: &mut HashSet<String>,
    ) {
        let steamapps = library.join("steamapps");
        let Ok(entries) = std::fs::read_dir(&steamapps) else {
            return;
        };
        for entry in entries.flatten() {
            let filename = entry.file_name();
            let filename = filename.to_string_lossy();
            if !filename.starts_with("appmanifest_") || !filename.ends_with(".acf") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let Some(parsed) = parse_acf(&text) else {
                continue;
            };
            if !parsed.fully_installed || is_steam_tool(&parsed.appid, &parsed.name) {
                continue;
            }
            let install_path = steamapps.join("common").join(&parsed.installdir);
            if !install_path.is_dir() {
                continue;
            }
            let id = format!("steam:{}", parsed.appid);
            if !seen.insert(id.clone()) {
                continue;
            }
            let launch_path = pick_launch_exe(&install_path, &parsed.name);
            games.push(ScannedGame {
                id,
                name: parsed.name,
                cover: steam_cover(&parsed.appid),
                cover_path: String::new(),
                install_path: install_path.display().to_string(),
                launch_path,
            });
        }
    }

    fn scan_epic(games: &mut Vec<ScannedGame>, seen: &mut HashSet<String>) {
        let program_data =
            std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
        let dir = PathBuf::from(program_data)
            .join("Epic")
            .join("EpicGamesLauncher")
            .join("Data")
            .join("Manifests");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("item") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(item) = serde_json::from_str::<EpicItem>(&text) else {
                continue;
            };
            if item.incomplete || item.display_name.trim().is_empty() {
                continue;
            }
            let install = PathBuf::from(item.install_location.trim());
            if !install.is_dir() {
                continue;
            }
            let key = if !item.app_name.is_empty() {
                item.app_name.clone()
            } else if !item.catalog_item_id.is_empty() {
                item.catalog_item_id.clone()
            } else {
                item.installation_guid.clone()
            };
            if key.is_empty() {
                continue;
            }
            let id = format!("epic:{key}");
            if !seen.insert(id.clone()) {
                continue;
            }
            let launch_path = if item.launch_executable.trim().is_empty() {
                pick_launch_exe(&install, &item.display_name)
            } else {
                install
                    .join(item.launch_executable.trim())
                    .display()
                    .to_string()
            };
            games.push(ScannedGame {
                id,
                name: item.display_name,
                cover: String::new(),
                cover_path: String::new(),
                install_path: install.display().to_string(),
                launch_path,
            });
        }
    }

    fn epic_install_dirs() -> Vec<String> {
        let program_data =
            std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
        let dir = PathBuf::from(program_data)
            .join("Epic")
            .join("EpicGamesLauncher")
            .join("Data")
            .join("Manifests");
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut dirs = Vec::new();
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|ext| ext.to_str()) != Some("item") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let Ok(item) = serde_json::from_str::<EpicItem>(&text) else {
                continue;
            };
            if item.incomplete || item.install_location.trim().is_empty() {
                continue;
            }
            dirs.push(item.install_location);
        }
        dirs
    }

    fn read_uninstall(
        app_handle: &tauri::AppHandle,
        root: &RegKey,
        path: &str,
        hive: &str,
        epic_dirs: &[String],
        found: &mut HashMap<String, ScannedApp>,
    ) {
        let Ok(key) = root.open_subkey(path) else {
            return;
        };
        for name in key.enum_keys().flatten() {
            let Ok(sub) = key.open_subkey(&name) else {
                continue;
            };
            let display = reg_string(&sub, "DisplayName");
            let system_component = reg_dword(&sub, "SystemComponent");
            let release_type = reg_string(&sub, "ReleaseType");
            let parent = reg_string(&sub, "ParentKeyName");
            if is_noise_app(&display, system_component, &release_type, &parent) {
                continue;
            }
            let install_path = reg_string(&sub, "InstallLocation")
                .trim()
                .trim_matches('"')
                .to_string();
            let display_icon = reg_string(&sub, "DisplayIcon");
            let uninstall = reg_string(&sub, "UninstallString");
            let icon = clean_reg_path(&display_icon);
            if is_scanned_game(&name, &install_path, &icon, &uninstall, epic_dirs) {
                continue;
            }
            let launch_path = if icon.to_ascii_lowercase().ends_with(".exe") {
                icon
            } else {
                String::new()
            };
            let id = format!("app:{hive}:{name}");
            let icon_path = crate::media::cached_icon(app_handle, &id, &display_icon);
            let app = ScannedApp {
                id,
                name: display.trim().to_string(),
                icon_path,
                install_path,
                launch_path,
            };
            remember_app(found, app);
        }
    }

    fn remember_app(found: &mut HashMap<String, ScannedApp>, app: ScannedApp) {
        let key = app.name.to_lowercase();
        match found.get(&key) {
            Some(existing) if !existing.install_path.is_empty() => {}
            Some(_) if app.install_path.is_empty() => {}
            _ => {
                found.insert(key, app);
            }
        }
    }

    fn reg_string(key: &RegKey, name: &str) -> String {
        key.get_value::<String, _>(name).unwrap_or_default()
    }

    fn reg_dword(key: &RegKey, name: &str) -> u32 {
        key.get_value::<u32, _>(name).unwrap_or(0)
    }

    fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for path in paths {
            let key = path
                .to_string_lossy()
                .replace('/', "\\")
                .to_ascii_lowercase();
            if seen.insert(key) {
                out.push(path);
            }
        }
        out
    }

    #[derive(serde::Deserialize)]
    struct EpicItem {
        #[serde(default, rename = "DisplayName")]
        display_name: String,
        #[serde(default, rename = "InstallLocation")]
        install_location: String,
        #[serde(default, rename = "LaunchExecutable")]
        launch_executable: String,
        #[serde(default, rename = "AppName")]
        app_name: String,
        #[serde(default, rename = "bIsIncompleteInstall")]
        incomplete: bool,
        #[serde(default, rename = "CatalogItemId")]
        catalog_item_id: String,
        #[serde(default, rename = "InstallationGuid")]
        installation_guid: String,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_the_games_own_process() {
        assert!(process_belongs_to_game(
            r"D:\SteamLibrary\steamapps\common\Elden Ring\eldenring.exe",
            r"D:\SteamLibrary\steamapps\common\Elden Ring",
            r"D:\SteamLibrary\steamapps\common\Elden Ring\start_protected_game.exe",
        ));
        assert!(process_belongs_to_game(
            r"C:\Games\Hades.exe",
            r"C:\Games",
            r"C:\Games\Hades.exe",
        ));
        assert!(!process_belongs_to_game(
            r"C:\Games\Hades.exe",
            r"C:\Games",
            r"C:\Games\Other.exe",
        ));
        assert!(!process_belongs_to_game(
            r"D:\SteamLibrary\steamapps\common\Elden Ring\eldenring.exe",
            r"D:\SteamLibrary\steamapps\common\Elden Ring",
            r"C:\Program Files (x86)\Steam\steam.exe",
        ));
        assert!(!process_belongs_to_game(
            r"D:\SteamLibrary\steamapps\common\Elden Ring\eldenring.exe",
            r"D:\SteamLibrary\steamapps\common\Elden Ring",
            r"D:\SteamLibrary\steamapps\common\Elden Ring\steamwebhelper.exe",
        ));
        assert!(process_belongs_to_game(
            r"D:\SteamLibrary\steamapps\common\Elden Ring\eldenring.exe",
            r"D:\SteamLibrary\steamapps\common\Elden Ring",
            "eldenring.exe",
        ));
        assert!(!process_belongs_to_game(
            r"D:\SteamLibrary\steamapps\common\Elden Ring\eldenring.exe",
            r"D:\SteamLibrary\steamapps\common\Elden Ring",
            "steam.exe",
        ));
    }

    #[test]
    fn reads_library_folders() {
        let text = r#"
"libraryfolders"
{
    "0"
    {
        "path"		"C:\\Program Files (x86)\\Steam"
        "apps"
        {
            "730"		"123"
        }
    }
    "1"		"D:\\SteamLibrary"
}
"#;
        let paths = library_roots_from_vdf(text);
        assert_eq!(
            paths,
            vec![
                r"C:\Program Files (x86)\Steam".to_string(),
                r"D:\SteamLibrary".to_string(),
            ]
        );
    }

    #[test]
    fn reads_installed_acf() {
        let text = r#"
"AppState"
{
    "appid"		"730"
    "name"		"Counter-Strike 2"
    "StateFlags"		"4"
    "installdir"		"Counter-Strike Global Offensive"
}
"#;
        let game = parse_acf(text).unwrap();
        assert_eq!(game.appid, "730");
        assert_eq!(game.name, "Counter-Strike 2");
        assert!(game.fully_installed);
        assert!(!is_steam_tool(&game.appid, &game.name));
    }

    #[test]
    fn skips_uninstalled_and_tools() {
        let text = r#"
"AppState"
{
    "appid"		"228980"
    "name"		"Steamworks Common Redistributables"
    "StateFlags"		"4"
    "installdir"		"Steamworks Shared"
}
"#;
        let game = parse_acf(text).unwrap();
        assert!(is_steam_tool(&game.appid, &game.name));

        let missing = r#"
"appid" "10"
"name" "Gone"
"StateFlags" "2"
"installdir" "Gone"
"#;
        assert!(!parse_acf(missing).unwrap().fully_installed);
    }

    #[test]
    fn filters_app_noise() {
        assert!(is_noise_app("Update for Microsoft Windows", 0, "", ""));
        assert!(is_noise_app("Microsoft Visual C++ 2015", 0, "", ""));
        assert!(is_noise_app("Real Game", 1, "", ""));
        assert!(!is_noise_app("Steam", 0, "", ""));
    }

    #[test]
    fn builds_store_launch_urls() {
        assert_eq!(
            protocol_url("steam:730").as_deref(),
            Some("steam://rungameid/730")
        );
        assert_eq!(protocol_url("steam:"), None);
        assert_eq!(protocol_url("steam:12a"), None);
        assert_eq!(
            protocol_url("epic:Fortnite").as_deref(),
            Some("com.epicgames.launcher://apps/Fortnite?action=launch")
        );
        assert_eq!(protocol_url("epic:{GUID}"), None);
        assert_eq!(protocol_url("app:hklm:Steam"), None);
    }

    #[test]
    fn keeps_steam_client_out_of_game_filter() {
        assert!(is_scanned_game("Steam App 730", "", "", "", &[]));
        assert!(is_scanned_game(
            "Counter-Strike",
            r"D:\Steam\steamapps\common\Counter-Strike",
            "",
            "",
            &[]
        ));
        assert!(!is_scanned_game(
            "Steam",
            r"C:\Program Files (x86)\Steam",
            "",
            "",
            &[]
        ));
        assert!(is_scanned_game(
            "Fortnite",
            r"D:\Epic\Fortnite",
            "",
            "",
            &[r"D:\Epic\Fortnite".to_string()]
        ));
    }

    #[test]
    fn strips_icon_index() {
        assert_eq!(
            clean_reg_path(r#""C:\Games\App\App.exe",0"#),
            r"C:\Games\App\App.exe"
        );
    }
}
