//! 把浮层顶到最前面 —— **大屏模式（FSE）下必须自己走 Win32**。
//!
//! 为什么 Tauri 的 `set_always_on_top(true)` 不够：它只保证窗口**属于**置顶层，
//! 而同一层里谁压谁由**激活顺序**决定。大屏模式下启动器是铺满整屏的前台窗口，
//! 我们的 `show()` / `set_focus()` 都是后台进程发起的，Windows 的**前台锁**
//! 会让 `SetForegroundWindow` 静默失败（返回 0，不报错）—— 于是窗口「已显示、
//! 位置也对、`is_visible()` 也是 true」，但永远压在启动器下面：桌面模式
//! （启动器让出全屏、回到窗口化）一切正常，一进大屏模式就「呼不出来」。
//!
//! 这是 0.1.33 记过的那条老账（「第二窗已 shown 但被全屏挡住」，见 STATUS.md），
//! 当年的解法就是下面三件事，0.1.35 / 0.1.38 / 0.1.39 逐步补齐：
//!
//! - `detach_owner`：清掉 `GW_OWNER`（有 owner 的窗口 z 序受限，不能像 Game Bar
//!   那样自由浮动），并补 `WS_EX_TOOLWINDOW`（不进 Alt+Tab / 任务栏）。
//! - `force_topmost`：`SetWindowPos(HWND_TOPMOST)` 把窗口推到置顶层**最上面**，
//!   同时把 `WS_EX_TOPMOST` 直接写进扩展样式，不依赖 Tauri 的异步设置。
//! - `steal_foreground`：先补一次 `VK_MENU` 按下/抬起解锁前台锁，再用
//!   `AttachThreadInput` + `BringWindowToTop` + `SetForegroundWindow` +
//!   `SetActiveWindow` 真的把前台抢过来（与启动器 `scan.rs::focus_window` 同一套手法）。
//!
//! 这段代码 0.1.39–0.1.45 一直住在启动器的 `src-tauri/src/frontend.rs` 里，
//! 0.1.46 拆成独立程序时没有跟着搬过来（只剩一句 `set_always_on_top`），0.1.48 补回。
//!
//! **只在 `show()` 里调用**：`force_topmost` 带 `SWP_SHOWWINDOW`，对一个隐藏窗口
//! 调用会把它显示出来 —— 0.1.45「窗口在屏上、状态却是关的」正是这么来的（那时在
//! `create_hidden()` 里先 `force_topmost` 再 `hide()`）。在这里它是显示动作的一部分，
//! 紧接着就会把真实可见性写进日志，不会出现那种状态与现场不符。

use tauri::WebviewWindow;

/// 显示**前**：清 owner + 推到置顶层最上面。
#[cfg(windows)]
pub fn prepare(window: &WebviewWindow) {
    win::detach_owner(window);
    win::force_topmost(window);
}

/// 显示**后**：再清一次 owner、顶一次、抢前台、收尾再顶一次。
/// 抢前台会改变 Z 序，所以最后那一下不能省（与 0.1.45 的顺序逐字一致）。
#[cfg(windows)]
pub fn grab(window: &WebviewWindow) {
    win::detach_owner(window);
    win::force_topmost(window);
    win::steal_foreground(window);
    win::force_topmost(window);
}

/// 现场快照，供日志定位：前台是谁、我们置顶没有、我们上面压着谁。
#[cfg(windows)]
pub fn probe(window: &WebviewWindow) -> Option<String> {
    win::probe(window)
}

/// 非 Windows 没有这套 Win32 手法，也没有「被全屏窗口压住」这回事：三个函数都只留签名，
/// 方便本机 `cargo check`（与 `chord.rs` 同一套做法）。
#[cfg(not(windows))]
pub fn prepare(_window: &WebviewWindow) {}

#[cfg(not(windows))]
pub fn grab(_window: &WebviewWindow) {}

#[cfg(not(windows))]
pub fn probe(_window: &WebviewWindow) -> Option<String> {
    None
}

#[cfg(windows)]
mod win {
    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, SetActiveWindow, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, BringWindowToTop, GetAncestor, GetClassNameW,
        GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, SetWindowLongPtrW,
        SetWindowLongW, SetWindowPos, ASFW_ANY, GA_ROOT, GWLP_HWNDPARENT, GWL_EXSTYLE, GW_HWNDPREV,
        HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };

    /// Tauri 给的是 `windows` crate 的 HWND，`windows-sys` 那边是裸指针别名，所以
    /// `.0 as HWND` 是直接转指针。顺手取根窗：Z 序、owner、置顶都只对顶层窗有意义。
    fn root(window: &WebviewWindow) -> Option<HWND> {
        let hwnd: HWND = window.hwnd().ok()?.0 as HWND;
        unsafe {
            let top = GetAncestor(hwnd, GA_ROOT);
            Some(if top.is_null() { hwnd } else { top })
        }
    }

    /// 断开 owner：浮层的 owner 是主窗，有 owner 的窗口 z 序要跟着 owner 排，
    /// 浮不到全屏窗口上面去。
    pub fn detach_owner(window: &WebviewWindow) {
        let Some(hwnd) = root(window) else {
            return;
        };
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
        }
    }

    /// 推到置顶层最上面，并把 `WS_EX_TOPMOST` / `WS_EX_TOOLWINDOW` 直接写进扩展样式。
    pub fn force_topmost(window: &WebviewWindow) {
        let Some(hwnd) = root(window) else {
            return;
        };
        unsafe {
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
            SetWindowLongW(
                hwnd,
                GWL_EXSTYLE,
                ex | WS_EX_TOPMOST as i32 | WS_EX_TOOLWINDOW as i32,
            );
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
        }
    }

    /// 真抢前台。后台进程直接 `SetForegroundWindow` 会被前台锁挡掉（只闪任务栏、不报错），
    /// 所以先补一次 `VK_MENU` 的按下/抬起把锁解开 —— 启动器里用了很久的老办法。
    pub fn steal_foreground(window: &WebviewWindow) {
        let Some(hwnd) = root(window) else {
            return;
        };
        unsafe {
            AllowSetForegroundWindow(ASFW_ANY);
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
            if attach_target {
                AttachThreadInput(current, target_thread, 0);
            }
            if attach_foreground {
                AttachThreadInput(current, foreground_thread, 0);
            }
        }
    }

    /// 一行现场：前台窗口 + 我们的置顶位/真实矩形 + 压在我们上面的可见窗口。
    /// `above` 里出现 `FantasyHub` 就是被全屏启动器压住；`topmost=false` 说明置顶没写进去；
    /// `fg=true` 说明前台也抢到了 —— 三种症状对应三种修法，别再靠猜。
    pub fn probe(window: &WebviewWindow) -> Option<String> {
        let hwnd = root(window)?;
        unsafe {
            let foreground = GetForegroundWindow();
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            GetWindowRect(hwnd, &mut rect);
            let mut above: Vec<String> = Vec::new();
            let mut cursor = GetWindow(hwnd, GW_HWNDPREV);
            while !cursor.is_null() && above.len() < 4 {
                if IsWindowVisible(cursor) != 0 {
                    above.push(describe(cursor));
                }
                cursor = GetWindow(cursor, GW_HWNDPREV);
            }
            let above = if above.is_empty() {
                "none".to_string()
            } else {
                above.join(", ")
            };
            Some(format!(
                "fg={} | ours topmost={} fg={} rect={},{} {}x{} | above={}",
                describe(foreground),
                ex & WS_EX_TOPMOST != 0,
                foreground == hwnd,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                above
            ))
        }
    }

    /// 窗口 → `类名"标题"(pid=1234)`，控制字符和引号清掉、只留一眼能认出来的长度。
    fn describe(hwnd: HWND) -> String {
        if hwnd.is_null() {
            return "none".into();
        }
        unsafe {
            let mut class = [0u16; 64];
            let class_len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
            let mut title = [0u16; 96];
            let title_len = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let class = String::from_utf16_lossy(&class[..class_len.max(0) as usize]);
            let title = String::from_utf16_lossy(&title[..title_len.max(0) as usize]);
            format!("{class}\"{}\"(pid={pid})", tidy(&title))
        }
    }

    fn tidy(text: &str) -> String {
        let cleaned: String = text
            .chars()
            .map(|c| if c.is_control() || c == '"' { ' ' } else { c })
            .collect();
        let trimmed = cleaned.trim();
        if trimmed.chars().count() > 40 {
            let head: String = trimmed.chars().take(40).collect();
            format!("{head}...")
        } else {
            trimmed.to_string()
        }
    }
}
