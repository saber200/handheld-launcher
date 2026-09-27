/// Xbox 仍是全屏体验的主应用时，Windows 会把它的窗口放在最前面，有时还会关掉启动器。
/// 这个进程在旁边等到进入全屏体验：关掉 Xbox 的窗口，启动器不在就再打开，然后自己退出。
/// 不结束 Game Bar，也不结束 Xbox 的后台。

pub fn is_xbox_ui_process(file_name: &str) -> bool {
    matches!(
        file_name.to_ascii_lowercase().as_str(),
        "xboxpcapp.exe" | "xboxpcappft.exe" | "xboxapp.exe"
    )
}

pub fn is_xbox_frame_window(file_name: &str, title: &str) -> bool {
    file_name.eq_ignore_ascii_case("ApplicationFrameHost.exe") && title.trim().eq_ignore_ascii_case("Xbox")
}

pub fn start() {
    #[cfg(windows)]
    windows::start();
}

pub fn watch() {
    #[cfg(windows)]
    windows::watch();
}

#[cfg(windows)]
mod windows {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{
        CloseHandle, FALSE, HANDLE, INVALID_HANDLE_VALUE, LPARAM, TRUE, WAIT_ABANDONED, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::System::Threading::{
        CreateMutexW, GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, ReleaseMutex,
        WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, SetForegroundWindow,
        ShowWindow, SW_RESTORE, WM_CLOSE,
    };

    const DETACHED: u32 = 0x00000008 | 0x00000200 | 0x08000000;

    pub fn start() {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let _ = std::process::Command::new(exe)
            .arg("--fse-watch")
            .creation_flags(DETACHED)
            .spawn();
    }

    pub fn watch() {
        let Some(_guard) = lock_watch() else {
            return;
        };
        let mut seen_fse = false;
        let mut fse_since: Option<Instant> = None;
        let mut stable_since: Option<Instant> = None;
        let mut saw_xbox = false;
        let mut restarts = 0u8;
        loop {
            if user_quit() {
                return;
            }
            let fse = fse_active();
            if !fse {
                if seen_fse {
                    return;
                }
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            seen_fse = true;
            let entered = fse_since.get_or_insert_with(Instant::now);
            if entered.elapsed() > Duration::from_secs(60) {
                return;
            }
            if !launcher_running() {
                stable_since = None;
                if restarts < 3 {
                    restarts += 1;
                    launch_again();
                }
            }
            if close_xbox_windows() {
                saw_xbox = true;
                stable_since = None;
                reveal_launcher();
            } else if saw_xbox && launcher_running() {
                let since = stable_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= Duration::from_secs(2) {
                    return;
                }
            } else if !saw_xbox && launcher_running() && entered.elapsed() > Duration::from_secs(25) {
                return;
            } else {
                stable_since = None;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    struct WatchLock(HANDLE);

    impl Drop for WatchLock {
        fn drop(&mut self) {
            unsafe {
                ReleaseMutex(self.0);
                CloseHandle(self.0);
            }
        }
    }

    fn lock_watch() -> Option<WatchLock> {
        let name: Vec<u16> = "Local\\HandheldLauncherFseWatch".encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), FALSE, name.as_ptr()) };
        if handle.is_null() {
            return None;
        }
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
            unsafe { CloseHandle(handle) };
            return None;
        }
        Some(WatchLock(handle))
    }

    fn user_quit() -> bool {
        let Some(appdata) = std::env::var_os("APPDATA") else {
            return false;
        };
        PathBuf::from(appdata)
            .join("handheld-launcher")
            .join("suppress")
            .is_file()
    }

    fn fse_active() -> bool {
        static SLOT: OnceLock<Option<unsafe extern "system" fn() -> isize>> = OnceLock::new();
        let probe = SLOT.get_or_init(|| unsafe {
            let lib_name: Vec<u16> = "api-ms-win-gaming-experience-l1-1-0.dll"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let lib = LoadLibraryW(lib_name.as_ptr());
            if lib.is_null() {
                return None;
            }
            GetProcAddress(lib, c"IsGamingFullScreenExperienceActive".as_ptr().cast())
        });
        probe.map(|fun| unsafe { fun() != 0 }).unwrap_or(false)
    }

    fn launcher_running() -> bool {
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let Some(mine) = exe.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        let self_pid = unsafe { GetCurrentProcessId() };
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return false;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut found = false;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    let name = utf16_buf(&entry.szExeFile);
                    if entry.th32ProcessID != self_pid && name.eq_ignore_ascii_case(mine) {
                        found = true;
                        break;
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

    fn launch_again() {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let _ = std::process::Command::new(exe).creation_flags(DETACHED).spawn();
    }

    fn close_xbox_windows() -> bool {
        let mut closed = false;
        unsafe {
            EnumWindows(Some(on_window), &mut closed as *mut bool as LPARAM);
        }
        closed
    }

    unsafe extern "system" fn on_window(hwnd: windows_sys::Win32::Foundation::HWND, lparam: LPARAM) -> i32 {
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let title = window_title(hwnd);
        let lower = title.to_lowercase();
        if lower.contains("game bar") || lower.contains("gamebar") || lower.contains("游戏栏") {
            return TRUE;
        }
        let Some(file_name) = process_file_name(hwnd) else {
            return TRUE;
        };
        let xbox = (super::is_xbox_ui_process(&file_name) && !title.is_empty())
            || super::is_xbox_frame_window(&file_name, &title);
        if xbox && lparam != 0 {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
            unsafe {
                *(lparam as *mut bool) = true;
            }
        }
        TRUE
    }

    fn reveal_launcher() {
        unsafe {
            EnumWindows(Some(on_launcher), 0);
        }
    }

    unsafe extern "system" fn on_launcher(hwnd: windows_sys::Win32::Foundation::HWND, _: LPARAM) -> i32 {
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let Some(file_name) = process_file_name(hwnd) else {
            return TRUE;
        };
        let Ok(exe) = std::env::current_exe() else {
            return TRUE;
        };
        let Some(mine) = exe.file_name().and_then(|name| name.to_str()) else {
            return TRUE;
        };
        if file_name.eq_ignore_ascii_case(mine) {
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
        TRUE
    }

    fn process_file_name(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<String> {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == 0 {
            return None;
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) };
        if process.is_null() {
            return None;
        }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len) };
        unsafe { CloseHandle(process) };
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        Some(path.rsplit(['\\', '/']).next().unwrap_or("").to_string())
    }

    fn window_title(hwnd: windows_sys::Win32::Foundation::HWND) -> String {
        let mut buf = [0u16; 256];
        let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }

    fn utf16_buf(buf: &[u16]) -> String {
        let end = buf.iter().position(|unit| *unit == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::{is_xbox_frame_window, is_xbox_ui_process};

    #[test]
    fn names_the_xbox_window_and_leaves_game_bar() {
        assert!(is_xbox_ui_process("XboxPcApp.exe"));
        assert!(is_xbox_ui_process("xboxapp.exe"));
        assert!(!is_xbox_ui_process("GameBar.exe"));
        assert!(!is_xbox_ui_process("XboxGameBarWidgets.exe"));
        assert!(!is_xbox_ui_process("gamingservices.exe"));
        assert!(is_xbox_frame_window("ApplicationFrameHost.exe", "Xbox"));
        assert!(!is_xbox_frame_window("ApplicationFrameHost.exe", "Xbox Game Bar"));
        assert!(!is_xbox_frame_window("ApplicationFrameHost.exe", "游戏栏"));
    }
}
