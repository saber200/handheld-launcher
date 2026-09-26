use serde::Serialize;
use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use std::collections::{HashMap, HashSet};
#[cfg(windows)]
use std::path::{Path, PathBuf};

/// Set after a launch minimizes the window. The next focus restores fullscreen once.
pub static RESUME_FULLSCREEN: AtomicBool = AtomicBool::new(false);

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
pub fn launch_item(
    app: tauri::AppHandle,
    id: String,
    launch_path: String,
    install_path: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::launch(&id, &launch_path, &install_path)?;
        tuck_launcher(&app);
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, launch_path, install_path);
        Err("只能在 Windows 上启动".into())
    }
}

#[cfg(windows)]
fn tuck_launcher(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.set_fullscreen(false);
    let _ = window.minimize();
    RESUME_FULLSCREEN.store(true, std::sync::atomic::Ordering::Relaxed);
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

    pub fn launch(id: &str, launch_path: &str, install_path: &str) -> Result<(), String> {
        if id.starts_with("steam:") {
            let url = protocol_url(id).ok_or("无效的 Steam 游戏")?;
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
            return Err("无效的启动地址".into());
        }
        std::process::Command::new("cmd")
            .args(["/C", "start", "", target])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| format!("无法启动：{err}"))?;
        Ok(())
    }

    fn spawn_exe(launch_path: &str, install_path: &str) -> Result<(), String> {
        let path = PathBuf::from(launch_path.trim());
        let is_exe = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
        if !path.is_file() || !is_exe {
            return Err("没有可启动的程序".into());
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
        cmd.spawn().map_err(|err| format!("无法启动：{err}"))?;
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
                    game.cover.clear();
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
