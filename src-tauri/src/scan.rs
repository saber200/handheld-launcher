use serde::Serialize;
use std::sync::Mutex;
#[cfg(windows)]
use std::collections::{HashMap, HashSet};
#[cfg(windows)]
use std::path::{Path, PathBuf};

use crate::i18n::pick;

/// Games this shell started a moment ago — a second click is not a second start.
static RECENT_LAUNCHES: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|dur| u64::try_from(dur.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
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
    /// 占用空间（字节）。0 = **不知道**，界面按「这一格不画」处理，不许当 0 显示。
    /// Steam 取 `appmanifest_*.acf` 的 `SizeOnDisk`、Epic 取 manifest 的 `InstallSize`；
    /// 手动添加 / 注册表扫出来的游戏没有这个数。
    pub size_bytes: u64,
    /// 总时长（分钟）。0 = 不知道。只有 Steam 有：`userdata/<id>/config/localconfig.vdf` 里
    /// `apps → <appid> → Playtime`，Steam 自己也是拿这个显示「已玩 x 小时」的。
    pub playtime_minutes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedApp {
    pub id: String,
    pub name: String,
    pub icon_path: String,
    pub install_path: String,
    pub launch_path: String,
    /// 版本（`DisplayVersion`）。空 = 注册表里没写（很多软件不填）。
    pub version: String,
    /// 占用空间（字节），来自注册表 `EstimatedSize`（KB，Windows「应用和功能」里显示的就是它）。
    /// 0 = 注册表没写 —— 这个值本来就允许缺失，也允许不准，所以只能当参考值显示。
    pub size_bytes: u64,
}

#[tauri::command]
pub async fn scan_games(app: tauri::AppHandle) -> Vec<ScannedGame> {
    crate::off_main(move || scan_games_now(&app)).await.unwrap_or_default()
}

fn scan_games_now(app: &tauri::AppHandle) -> Vec<ScannedGame> {
    #[cfg(windows)]
    {
        return windows::scan_games(app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Vec::new()
    }
}

#[tauri::command]
pub async fn scan_apps(app: tauri::AppHandle) -> Vec<ScannedApp> {
    crate::off_main(move || scan_apps_now(&app)).await.unwrap_or_default()
}

fn scan_apps_now(app: &tauri::AppHandle) -> Vec<ScannedApp> {
    #[cfg(windows)]
    {
        return windows::scan_apps(app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Vec::new()
    }
}

#[tauri::command]
pub async fn cache_covers(
    app: tauri::AppHandle,
    covers: Vec<crate::media::CoverRequest>,
) -> Vec<crate::media::CachedCover> {
    // Network: an 8s connect / 20s read timeout per cover. On the event loop a
    // single unreachable CDN froze the whole UI for the length of that timeout.
    crate::off_main(move || crate::media::cache_remote_covers(&app, covers))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn steam_library_cover(app_id: String) -> Result<String, String> {
    match crate::off_main(move || crate::media::fetch_steam_library_cover(&app_id)).await {
        Ok(found) => found,
        Err(err) => Err(err),
    }
}

/// 候选表的数据结构在共享内核里 —— 独立前端自己判断进程时用的是同一份。
pub use fh_core::process::RunningQuery;

enum GamePresence {
    Absent,
    Running,
    Focused,
}

/// Polled every 1.5s by the library. It snapshots the process list and opens
/// every process to read its image path — far too heavy for the event loop.
#[tauri::command]
pub async fn running_games(items: Vec<RunningQuery>) -> Vec<String> {
    crate::off_main(move || running_ids_now(items)).await.unwrap_or_default()
}

fn running_ids_now(items: Vec<RunningQuery>) -> Vec<String> {
    // 实现搬到了共享内核：独立前端也要用同一套判断（它自己枚举进程，不需要提权），
    // 两份实现迟早会走偏，所以只留一份。
    fh_core::process::running_ids(&items)
}

#[tauri::command]
pub async fn quit_game(id: String, launch_path: String, install_path: String) -> Result<u32, String> {
    match crate::off_main(move || quit_game_now(id, launch_path, install_path)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn quit_game_now(id: String, launch_path: String, install_path: String) -> Result<u32, String> {
    #[cfg(not(windows))]
    {
        let _ = (id, launch_path, install_path);
        Err(pick("只能在 Windows 上退出游戏", "Quitting games only works on Windows."))
    }
    // 结束进程的实现也搬到了共享内核：独立前端自己退游戏（免提权）。
    #[cfg(windows)]
    {
        let killed = fh_core::process::kill_game(&launch_path, &install_path);
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
}

#[tauri::command]
pub async fn launch_item(
    app: tauri::AppHandle,
    id: String,
    launch_path: String,
    install_path: String,
    switch_if_running: Option<bool>,
) -> Result<String, String> {
    match crate::off_main(move || {
        launch_item_now(app, id, launch_path, install_path, switch_if_running)
    })
    .await
    {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn launch_item_now(
    app: tauri::AppHandle,
    id: String,
    launch_path: String,
    install_path: String,
    switch_if_running: Option<bool>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        // The shell no longer hides itself on launch, so it needs no handle here.
        let _ = app;
        if switch_if_running.unwrap_or(false) {
            match windows::activate_game(&launch_path, &install_path) {
                GamePresence::Absent if launched_recently(&id) => return Ok("running".into()),
                GamePresence::Absent => {}
                GamePresence::Focused | GamePresence::Running => {
                    let switched = windows::reveal_game(&id, &launch_path, &install_path);
                    return Ok(if switched { "focused".into() } else { "running".into() });
                }
            }
        }
        // The shell stays where it is. Windows focuses whatever we start, and
        // nothing here calls set_focus on the shell — hiding ourselves was what
        // used to strand the library behind the game, with no task list to come
        // back from. What we do own is handing the *new* window the foreground:
        // an app that reuses a running process (Chrome) otherwise stays behind
        // our fullscreen shell.
        windows::allow_foreground();
        windows::launch(&id, &launch_path, &install_path)?;
        remember_launch(&id);
        let started = launch_path.clone();
        let install = install_path.clone();
        std::thread::spawn(move || windows::foreground_launched(&started, &install));
        return Ok("launched".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, launch_path, install_path, switch_if_running);
        Err(pick("只能在 Windows 上启动", "Launching only works on Windows."))
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

/// `steam:730` → `Some("730")`。不是 Steam 或 appid 不是纯数字 → `None`
/// （appid 会拼进命令行，非数字一律不收）。
/// 只被 `protocol_url` / Windows 那半边用，本机编译时同样按「只在测试里用」处理。
#[cfg_attr(not(windows), allow(dead_code))]
fn steam_appid(id: &str) -> Option<&str> {
    let appid = id.strip_prefix("steam:")?;
    (!appid.is_empty() && appid.chars().all(|c| c.is_ascii_digit())).then_some(appid)
}

/// Steam 静默启动的开关：`-silent` 让客户端不弹主窗口（待在托盘），`-applaunch <appid>` 直接起游戏。
///
/// 为什么不再直接用 `steam://rungameid/<appid>`：那是把 URL 交给 shell 处理，Steam 没在跑时会
/// 先把主窗口（没登录时还有登录框）弹到前台 —— 掌机上就是「点了游戏先跳出 Steam」。
/// 抽成纯函数是为了本机（macOS）也能断言：Windows 那半边编不了，删掉 `-silent` 没人看得出来。
/// 只有 Windows 那半边会调它，本机编译时按「只在测试里用」处理，不去污染 clippy 输出。
#[cfg_attr(not(windows), allow(dead_code))]
fn steam_silent_args(appid: &str) -> [String; 3] {
    ["-silent".to_string(), "-applaunch".to_string(), appid.to_string()]
}

/// 从候选里挑第一个真实存在的 `steam.exe`。注册表可能写目录（`SteamPath` / `InstallPath`），
/// 也可能直接写 exe（`SteamExe`），所以目录要自己补上 `steam.exe`，文件名也再验一遍 ——
/// 挑到别的 exe 的后果是静默启动悄悄退化成弹窗。纯函数，本机能测。
/// （签名里写全 `std::path::PathBuf`：`PathBuf` 的 import 在 Windows 那个 cfg 里，本机看不到它。）
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_steam_exe(candidates: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    for candidate in candidates {
        let path = if candidate.is_dir() {
            candidate.join("steam.exe")
        } else {
            candidate.clone()
        };
        let named_right = path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("steam.exe"));
        if named_right && path.is_file() {
            return Some(path);
        }
    }
    None
}

fn protocol_url(id: &str) -> Option<String> {
    if id.starts_with("steam:") {
        // 无效的 steam id 就是「没有可用的协议地址」，调用方会据此报错。
        return steam_appid(id).map(|appid| format!("steam://rungameid/{appid}"));
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

/// 路径规范化与“这个进程属于这个游戏吗”都搬到了共享内核（独立前端要用同一套，
/// 见 `fh_core::process`）。这里不再留同名薄壳：留着只会在 Windows 构建里报
/// “never used”（调用点早就改成直接打共享内核了），测试也直接打共享内核那份。

#[derive(Debug, PartialEq, Eq)]
struct AcfGame {
    appid: String,
    name: String,
    installdir: String,
    fully_installed: bool,
    /// `SizeOnDisk`（字节）。ACF 里没这一项就是 0 = 不知道。
    size_on_disk: u64,
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
    let mut size_on_disk = 0u64;
    for (key, value) in vdf_pairs(text) {
        if key.eq_ignore_ascii_case("appid") {
            appid = value;
        } else if key.eq_ignore_ascii_case("name") {
            name = value;
        } else if key.eq_ignore_ascii_case("installdir") {
            installdir = value;
        } else if key.eq_ignore_ascii_case("stateflags") {
            flags = value.parse().ok();
        } else if key.eq_ignore_ascii_case("SizeOnDisk") {
            // Steam 自己「已安装」页面显示的就是这个数（字节）。解析不了就当不知道。
            size_on_disk = value.trim().parse().unwrap_or(0);
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
        size_on_disk,
    })
}

/// 从 `localconfig.vdf` 里取出「每个 appid 的总时长（分钟）」。
///
/// 为什么要单独走一遍嵌套：上面那个 `vdf_pairs` 是**扁平**的（只认 key/value，不看 `{}`），
/// 而 localconfig 里 `apps` 块下面每个 appid 各有一个子块，一堆 appid 都有 `Playtime` ——
/// 扁平解析拿到的是一串无主的 Playtime，分不清属于谁。这里只认「`apps` 块某个子块里的
/// Playtime」这一种形状：少认几层，Steam 换一层裹皮也不会整个失效。
///
/// 真实结构（`UserLocalConfigStore` 那几层可能随版本变，所以不写死前缀）：
/// ```text
/// "Software" { "Valve" { "Steam" { "apps" { "<appid>" { "Playtime" "2560" } } } } }
/// ```
fn playtimes_from_localconfig(text: &str) -> Vec<(String, u64)> {
    let bytes = text.as_bytes();
    let mut stack: Vec<String> = Vec::new();
    let mut pending: Option<String> = None;
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => {
                stack.push(pending.take().unwrap_or_default());
                i += 1;
            }
            b'}' => {
                stack.pop();
                i += 1;
            }
            b'"' => {
                let Some((key, next)) = next_quoted(text, i) else {
                    break;
                };
                // 引号后面紧跟着另一个引号 = 这是一个键值对；否则这个键后面是 `{`。
                let after = next + (text[next..].len() - text[next..].trim_start().len());
                if text[after..].starts_with('"') {
                    if let Some((value, end)) = next_quoted(text, after) {
                        let owner = stack.get(stack.len().wrapping_sub(2)).map(String::as_str);
                        let block = stack.last().cloned().unwrap_or_default();
                        if key.eq_ignore_ascii_case("Playtime")
                            && !block.is_empty()
                            && owner.is_some_and(|name| name.eq_ignore_ascii_case("apps"))
                        {
                            if let Ok(minutes) = value.trim().parse::<u64>() {
                                out.push((block, minutes));
                            }
                        }
                        i = end;
                        continue;
                    }
                }
                pending = Some(key);
                i = next;
            }
            _ => i += 1,
        }
    }
    out
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

    /// Let the process we are about to start bring itself forward. Chrome, Steam
    /// and friends hand the request to a process that is already running, and
    /// that process needs this right or Windows refuses its SetForegroundWindow.
    pub fn allow_foreground() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
        unsafe {
            AllowSetForegroundWindow(ASFW_ANY);
        }
    }

    /// Hand the foreground to what we just started. The shell stays where it is,
    /// so an app that opens behind our fullscreen window would look like nothing
    /// happened. Polls briefly: the window appears a beat after the process, and
    /// an app that reuses an existing window is already there.
    pub fn foreground_launched(launch_path: &str, install_path: &str) {
        for _ in 0..16 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let pids = game_pids(launch_path, install_path);
            if let Some(hwnd) = game_window(&pids) {
                focus_window(hwnd);
                return;
            }
        }
    }

    fn game_pids(launch_path: &str, install_path: &str) -> Vec<u32> {
        fh_core::process::pids_for_game(launch_path, install_path)
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

    /// steam.exe 可能在哪儿：注册表里 `SteamExe` 直接是 exe，`SteamPath` / `InstallPath` 是目录；
    /// 最后两个默认安装位置是「注册表被清理过但 Steam 确实装在默认路径」时的兜底（都得先过
    /// `pick_steam_exe` 的存在性检查，写错路径不会误伤）。
    fn steam_exe_hints() -> Vec<PathBuf> {
        let mut hints = Vec::new();
        push_reg_path(
            HKEY_CURRENT_USER,
            r"Software\Valve\Steam",
            "SteamExe",
            &mut hints,
        );
        push_reg_path(
            HKEY_CURRENT_USER,
            r"Software\Valve\Steam",
            "SteamPath",
            &mut hints,
        );
        push_reg_path(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Valve\Steam",
            "InstallPath",
            &mut hints,
        );
        push_reg_path(
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Valve\Steam",
            "InstallPath",
            &mut hints,
        );
        hints.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
        hints.push(PathBuf::from(r"C:\Program Files\Steam"));
        hints
    }

    /// `steam.exe -silent -applaunch <appid>`。
    ///
    /// 边界（真机上要按这个口径验）：`-silent` 只对「Steam 启动那一刻」有效。客户端已经开着
    /// 主窗口时，这次调用等于给它发一条 applaunch，它的窗口该开着还开着 —— 我们**不强行最小化**，
    /// 因为那时弹出来的可能是登录框或更新提示，把它藏起来比多一个窗口更让人摸不着头脑。
    fn applaunch_silently(exe: &Path, appid: &str) -> Result<(), String> {
        std::process::Command::new(exe)
            .args(steam_silent_args(appid))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn launch(id: &str, launch_path: &str, install_path: &str) -> Result<(), String> {
        if id.starts_with("steam:") {
            let invalid = || pick("无效的 Steam 游戏", "That Steam game isn't valid.");
            let appid = steam_appid(id).ok_or_else(invalid)?;
            // 先试静默启动；找不到客户端或起不来才退回协议地址 ——
            // 宁可弹一次 Steam 窗口，也不能点了没反应。
            if let Some(exe) = super::pick_steam_exe(&steam_exe_hints()) {
                if applaunch_silently(&exe, appid).is_ok() {
                    return Ok(());
                }
            }
            let url = protocol_url(id).ok_or_else(invalid)?;
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
        // 时长只在 localconfig 里，而且**按账号**分文件：先一次性读出来做成 appid → 分钟的表，
        // 免得每个 appmanifest 都去翻一遍文件（Steam 库里几百个游戏，那是几百次读盘）。
        let playtimes = steam_playtimes(&roots);
        let mut games = Vec::new();
        let mut seen = HashSet::new();
        for root in &roots {
            for library in steam_libraries(root) {
                scan_steam_library(&library, &mut games, &mut seen, &playtimes);
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

    /// appid → 总时长（分钟）。逐个账号读 `<Steam>/userdata/<id>/config/localconfig.vdf`
    /// （时长是按账号存的）；同一个 appid 出现在多个账号里取最大值。
    /// 读不到就返回空表 —— 时长缺失只是少一格数据，不该影响扫描。
    fn steam_playtimes(roots: &[PathBuf]) -> HashMap<String, u64> {
        let mut out: HashMap<String, u64> = HashMap::new();
        for root in roots {
            let Ok(accounts) = std::fs::read_dir(root.join("userdata")) else {
                continue;
            };
            for account in accounts.flatten() {
                let config = account.path().join("config").join("localconfig.vdf");
                let Ok(text) = std::fs::read_to_string(&config) else {
                    continue;
                };
                for (appid, minutes) in playtimes_from_localconfig(&text) {
                    let slot = out.entry(appid).or_insert(0);
                    *slot = (*slot).max(minutes);
                }
            }
        }
        out
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
        playtimes: &HashMap<String, u64>,
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
                size_bytes: parsed.size_on_disk,
                playtime_minutes: playtimes.get(&parsed.appid).copied().unwrap_or(0),
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
                // Epic 的 manifest 里就有安装体积（字节）。时长只有 Steam 有 localconfig，
                // Epic 侧没有公开可读的等价物 —— 保持 0（界面不画这一格）。
                size_bytes: item.install_size,
                playtime_minutes: 0,
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
                version: reg_string(&sub, "DisplayVersion").trim().to_string(),
                // EstimatedSize 是 KB（Windows「应用和功能」里显示的就是它）。0 或缺席 = 不知道；
                // 溢出不了：u32 KB 最大约 4 TB。
                size_bytes: u64::from(reg_dword(&sub, "EstimatedSize")) * 1024,
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
        /// 安装体积（字节）。manifest 里通常有；没有就是 0 = 不知道。
        #[serde(default, rename = "InstallSize")]
        install_size: u64,
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
        assert!(fh_core::process::belongs_to_game(
            r"D:\SteamLibrary\steamapps\common\Elden Ring\eldenring.exe",
            r"D:\SteamLibrary\steamapps\common\Elden Ring",
            r"D:\SteamLibrary\steamapps\common\Elden Ring\start_protected_game.exe",
        ));
        assert!(fh_core::process::belongs_to_game(
            r"C:\Games\Hades.exe",
            r"C:\Games",
            r"C:\Games\Hades.exe",
        ));
        assert!(!fh_core::process::belongs_to_game(
            r"C:\Games\Hades.exe",
            r"C:\Games",
            r"C:\Games\Other.exe",
        ));
        assert!(!fh_core::process::belongs_to_game(
            r"D:\SteamLibrary\steamapps\common\Elden Ring\eldenring.exe",
            r"D:\SteamLibrary\steamapps\common\Elden Ring",
            r"C:\Program Files (x86)\Steam\steam.exe",
        ));
        assert!(!fh_core::process::belongs_to_game(
            r"D:\SteamLibrary\steamapps\common\Elden Ring\eldenring.exe",
            r"D:\SteamLibrary\steamapps\common\Elden Ring",
            r"D:\SteamLibrary\steamapps\common\Elden Ring\steamwebhelper.exe",
        ));
        assert!(fh_core::process::belongs_to_game(
            r"D:\SteamLibrary\steamapps\common\Elden Ring\eldenring.exe",
            r"D:\SteamLibrary\steamapps\common\Elden Ring",
            "eldenring.exe",
        ));
        assert!(!fh_core::process::belongs_to_game(
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

    /// Steam 游戏走 `steam.exe -silent -applaunch`（不弹客户端窗口）。这条断言防的是有人
    /// 顺手把 `-silent` 删回「直接丢 steam://rungameid」—— 那种改动在 macOS 上编得过、看不出来。
    #[test]
    fn steam_games_launch_silently() {
        assert_eq!(
            steam_silent_args("730"),
            ["-silent".to_string(), "-applaunch".to_string(), "730".to_string()]
        );
        assert_eq!(steam_appid("steam:730"), Some("730"));
        assert_eq!(steam_appid("steam:"), None);
        assert_eq!(steam_appid("steam:12a"), None);
        assert_eq!(steam_appid("epic:Fortnite"), None);
    }

    /// 候选里挑 steam.exe：目录要补上 `steam.exe`、名字不对 / 不存在的一律跳过。
    /// 挑错的后果是静默启动悄悄退化成弹窗，所以这条在本机（macOS）就要盯住。
    #[test]
    fn picks_only_a_real_steam_exe() {
        let dir = std::env::temp_dir().join(format!("hl-steam-exe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("steam.exe");
        std::fs::write(&fake, b"MZ").unwrap();
        let other = dir.join("other.exe");
        std::fs::write(&other, b"MZ").unwrap();

        assert_eq!(
            pick_steam_exe(std::slice::from_ref(&dir)),
            Some(fake.clone()),
            "目录候选要补 steam.exe"
        );
        assert_eq!(pick_steam_exe(&[other]), None, "名字不对不能当成 steam.exe");
        assert_eq!(
            pick_steam_exe(&[std::path::PathBuf::from("Z:\\no-such-steam")]),
            None
        );
        assert_eq!(pick_steam_exe(&[]), None);

        let _ = std::fs::remove_dir_all(&dir);
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

    /// 真 appmanifest 的形状（只留用得到的键），SizeOnDisk 是字节。
    const APP_MANIFEST: &str = r#"
"AppState"
{
	"appid"		"1245620"
	"Universe"		"1"
	"name"		"ELDEN RING"
	"StateFlags"		"4"
	"installdir"		"ELDEN RING"
	"SizeOnDisk"		"53687091200"
	"LastUpdated"		"1750000000"
}
"#;

    #[test]
    fn acf_keeps_size_on_disk() {
        let parsed = parse_acf(APP_MANIFEST).expect("appmanifest 应该能解析");
        assert_eq!(parsed.appid, "1245620");
        assert_eq!(parsed.installdir, "ELDEN RING");
        assert!(parsed.fully_installed);
        assert_eq!(parsed.size_on_disk, 53_687_091_200);
    }

    #[test]
    fn acf_without_size_on_disk_is_unknown_not_zero_bytes() {
        let text = "\"AppState\"\n{\n\t\"appid\"\t\t\"1\"\n\t\"installdir\"\t\t\"X\"\n}\n";
        let parsed = parse_acf(text).expect("缺 SizeOnDisk 也要能解析");
        assert_eq!(parsed.size_on_disk, 0);
    }

    /// 真 localconfig 的形状：`apps` 下面每个 appid 一个块，块里还有别的键和嵌套块。
    const LOCAL_CONFIG: &str = r#"
"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"apps"
				{
					"1245620"
					{
						"LastPlayed"		"1750000000"
						"Playtime"		"2560"
						"Playtime2wks"		"120"
						"cloud"
						{
							"last_sync_state"		"1"
						}
					}
					"367520"
					{
						"Playtime"		"15"
					}
				}
				"RecentGames"
				{
					"Playtime"		"9999"
				}
			}
		}
	}
}
"#;

    #[test]
    fn localconfig_playtime_is_looked_up_per_appid() {
        let found = playtimes_from_localconfig(LOCAL_CONFIG);
        // RecentGames 那个 9999 不是 appid 块里的，不能混进来
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|(id, minutes)| id == "1245620" && *minutes == 2560));
        assert!(found.iter().any(|(id, minutes)| id == "367520" && *minutes == 15));
    }

    #[test]
    fn localconfig_without_apps_block_yields_nothing() {
        let text = "\"UserLocalConfigStore\"\n{\n\t\"Software\"\n\t{\n\t\t\"Playtime\"\t\t\"3\"\n\t}\n}\n";
        assert!(playtimes_from_localconfig(text).is_empty());
    }
}
