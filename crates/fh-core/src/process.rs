//! “哪个游戏在跑 / 退掉它”。
//!
//! 这段逻辑从启动器的 `scan.rs` 搬过来（原样搬，行为不变），因为**独立前端要自己做**
//! 这两件事：前端是普通权限进程，枚举进程与 `TerminateProcess` 都不需要提权，所以
//! 启动器没运行也能用（FRONTEND.md §3）。启动器那边的 `scan.rs` 现在直接调这里，
//! 避免两份实现慢慢走偏。
//!
//! 匹配规则：先把进程全路径规范化，再看它是不是等于游戏的启动路径、或落在游戏安装目录
//! 之下；`steam.exe` / `explorer.exe` 这类公共进程明确排除在外。

use serde::{Deserialize, Serialize};

/// 前端问“这些库里条目里谁在跑”时传的候选表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningQuery {
    pub id: String,
    #[serde(default)]
    pub launch_path: String,
    #[serde(default)]
    pub install_path: String,
}

/// 候选表里正在运行的条目 id。
#[cfg(windows)]
pub fn running_ids(items: &[RunningQuery]) -> Vec<String> {
    let processes = process_paths();
    items
        .iter()
        .filter(|item| {
            processes.iter().any(|(_, path)| {
                belongs_to_game(&item.launch_path, &item.install_path, path)
            })
        })
        .map(|item| item.id.clone())
        .collect()
}

#[cfg(not(windows))]
pub fn running_ids(_items: &[RunningQuery]) -> Vec<String> {
    Vec::new()
}

/// 属于这个游戏的所有进程号（启动器还用它做「切到已运行的游戏」）。
#[cfg(windows)]
pub fn pids_for_game(launch_path: &str, install_path: &str) -> Vec<u32> {
    process_paths()
        .into_iter()
        .filter(|(_, path)| belongs_to_game(launch_path, install_path, path))
        .map(|(pid, _)| pid)
        .collect()
}

#[cfg(not(windows))]
pub fn pids_for_game(_launch_path: &str, _install_path: &str) -> Vec<u32> {
    Vec::new()
}

/// 结束该游戏的所有进程，返回结束掉的进程数。
#[cfg(windows)]
pub fn kill_game(launch_path: &str, install_path: &str) -> u32 {
    let mut killed = 0u32;
    for pid in pids_for_game(launch_path, install_path) {
        if terminate_pid(pid) {
            killed = killed.saturating_add(1);
        }
    }
    killed
}

#[cfg(not(windows))]
pub fn kill_game(_launch_path: &str, _install_path: &str) -> u32 {
    0
}

#[cfg(windows)]
fn terminate_pid(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_TERMINATE,
    };
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

#[cfg(windows)]
fn process_paths() -> Vec<(u32, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
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

#[cfg(windows)]
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

pub fn normalize_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim()
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn usable_game_root(path: &str) -> Option<String> {
    let norm = normalize_path(path);
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

/// 这个进程路径属于这个游戏吗？（启动器的库界面也用同一份判断）
pub fn belongs_to_game(launch_path: &str, install_path: &str, process_path: &str) -> bool {
    let process = normalize_path(process_path);
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
