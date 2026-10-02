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
//!
//! **0.1.50 补的三件事**（都是为了「别再静默失败」）：
//!
//! - **句柄兜底**：0.1.48 这里第一句就是 `window.hwnd().ok()?`，拿不到句柄就整个返回 ——
//!   于是置顶 / 清 owner / 抢前台**全部变成空操作，日志里一个字都没有**。现在兜底枚举本进程
//!   顶层窗口（挑面积最大的那个），并且 `probe` 每次都写清楚句柄是从哪条路来的。
//! - **每步查返回值**：`SetWindowPos` 被 UIPI 挡下时返回 0 而不报错，`GetLastError` 才说明
//!   原因；这里每次失败都写一行 `ok=false err=…`。
//! - **自检**：`on_top()` 问的是 `IsWindowVisible` + `WS_EX_TOPMOST`，而不是 Tauri 的
//!   `is_visible()`（那个只说「系统认为可见」，被整屏窗口压住时照样是 true）。
//!   浮层那边据此重试，最后再打印一次 `probe` 与截屏（见 `overlay.rs` / `shot.rs`）。

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

/// 自检重试时用：只再顶一次，**不碰前台锁**。
///
/// 为什么不直接复用 `grab`：里面有一次 `VK_MENU` 补按（解前台锁的老办法），那是一次性的解锁
/// 动作；自检最多重试 5 轮，每轮都补按一次 Alt 等于对着前台应用敲键盘 —— 不该有。
#[cfg(windows)]
pub fn retry_top(window: &WebviewWindow) {
    win::detach_owner(window);
    win::force_topmost(window);
}

/// **最硬的一下**：抢前台 + 再顶一次，然后把结果写进日志。
///
/// 只在自检判定「被压住了」之后用（`overlay.rs` 的重试与看护循环）。与 `grab` 的区别是
/// 它**不省那一次前台抢占** —— `retry_top` 刻意只顶不抢，是怕每 120 ms 敲一次 Alt；
/// 而这里本来就是「怎么都不上屏」的补救路径，值得动一次前台锁。
/// 顺序与 0.1.45 的真机结论一致：抢前台会改变 Z 序，所以抢完必须再顶一次。
#[cfg(windows)]
pub fn hard_raise(window: &WebviewWindow) {
    win::steal_foreground(window);
    win::force_topmost(window);
    fh_core::logutil::write_line(&format!(
        "frontend hard raise: on_top={} {}",
        win::on_top(window),
        win::probe(window).unwrap_or_else(|| "probe unavailable".to_string())
    ));
}

/// 自检：窗口现在**真的**在屏上、并且落在置顶层？
///
/// 为什么不用 `window.is_visible()`：它只是在问「系统认为这个窗口可见没有」，**被整屏窗口
/// 压住时它一样返回 true** —— 0.1.48 的现场就是这样：日志写 `is_visible=true`，人看不见。
/// 这里问的是更硬的两件事：`IsWindowVisible` + 扩展样式里的 `WS_EX_TOPMOST`（置顶那步到底
/// 写进去没有）。它仍然证明不了「肉眼可见」——那要靠 `::probe` 的 `above=` 和截屏比对。
#[cfg(windows)]
pub fn on_top(window: &WebviewWindow) -> bool {
    win::on_top(window)
}

/// 现场快照，供日志定位：句柄是怎么拿到的、前台是谁、我们置顶没有、我们上面压着谁。
/// **永远返回 `Some`**（拿不到句柄也说明原因）：0.1.48 这条诊断在真机上一次都没打印出来，
/// 就是因为拿不到句柄时它悄悄返回 `None`，而调用方只写 `if let Some(..)`。
#[cfg(windows)]
pub fn probe(window: &WebviewWindow) -> Option<String> {
    win::probe(window)
}

/// 非 Windows 没有这套 Win32 手法，也没有「被全屏窗口压住」这回事：签名保持一致，
/// 方便本机 `cargo check`（与 `chord.rs` 同一套做法）。
#[cfg(not(windows))]
pub fn prepare(_window: &WebviewWindow) {}

#[cfg(not(windows))]
pub fn grab(_window: &WebviewWindow) {}

#[cfg(not(windows))]
pub fn retry_top(_window: &WebviewWindow) {}

/// 非 Windows 上没有前台锁 / 置顶层这回事：空实现（与 `retry_top` 同一套做法）。
#[cfg(not(windows))]
pub fn hard_raise(_window: &WebviewWindow) {}

/// 非 Windows 上「自检」恒为通过：没有要修的层级问题，别让浮层的重试逻辑空转。
#[cfg(not(windows))]
pub fn on_top(_window: &WebviewWindow) -> bool {
    true
}

/// 非 Windows 上确实没有这套信息（调用方会把 `None` 写成一行的 `probe unavailable`）。
#[cfg(not(windows))]
pub fn probe(_window: &WebviewWindow) -> Option<String> {
    None
}

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::{GetLastError, SetLastError, HWND, LPARAM, RECT};
    use windows_sys::Win32::System::Threading::{
        AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, SetActiveWindow, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, BringWindowToTop, EnumWindows, GetAncestor, GetClassNameW,
        GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowLongW, GetWindowRect,
        GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
        SetWindowLongPtrW, SetWindowLongW, SetWindowPos, ASFW_ANY, GA_ROOT, GWLP_HWNDPARENT,
        GWL_EXSTYLE, GW_HWNDPREV, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };

    /// 句柄是从哪条路拿到的，`probe` 会把它写进日志（`hwnd=tauri|enum|none`）。
    const FROM_TAURI: u8 = 1;
    const FROM_ENUM: u8 = 2;
    const FROM_NONE: u8 = 3;
    static SOURCE: AtomicU8 = AtomicU8::new(0);
    /// 「走了兜底」「彻底拿不到」这两句话每个进程只说一次：一次显示要进出下面这些函数十来遍，
    /// 每遍都写会把日志刷爆，而这件事说明一次就够。
    static FALLBACK_LOGGED: AtomicBool = AtomicBool::new(false);
    static MISSING_LOGGED: AtomicBool = AtomicBool::new(false);

    fn source_name() -> &'static str {
        match SOURCE.load(Ordering::Relaxed) {
            FROM_TAURI => "tauri",
            FROM_ENUM => "enum",
            _ => "none",
        }
    }

    /// 拿我们自己那个顶层窗口的句柄。
    ///
    /// **为什么不只用 `window.hwnd()`**：它走的是「给主线程发消息、等回复」，任何一步异常
    /// （事件循环状态、平台差异、Tauri 版本变化）都会变成 `Err`；而 0.1.48 的调用方一律
    /// `?` 提前返回 —— 于是置顶那三件事**全部静默变成空操作**，日志里一个字都没有，现场
    /// 只剩「窗口显示了但人看不见」。所以这里补一条**不依赖 Tauri 运行时**的路：自己枚举
    /// 本进程的顶层窗口，挑面积最大的那个。走的是哪条路 `probe` 每次都写。
    fn hwnd_of(window: &WebviewWindow) -> Option<HWND> {
        match window.hwnd() {
            Ok(handle) => {
                let raw: HWND = handle.0 as HWND;
                SOURCE.store(FROM_TAURI, Ordering::Relaxed);
                // Z 序、owner、置顶都只对顶层窗有意义，所以取根窗。
                return unsafe {
                    let top = GetAncestor(raw, GA_ROOT);
                    Some(if top.is_null() { raw } else { top })
                };
            }
            Err(err) => {
                if !FALLBACK_LOGGED.swap(true, Ordering::Relaxed) {
                    fh_core::logutil::write_line(&format!(
                        "topmost: window.hwnd() unavailable ({err}) — falling back to our own window list"
                    ));
                }
            }
        }
        if let Some(hwnd) = own_top_level() {
            SOURCE.store(FROM_ENUM, Ordering::Relaxed);
            return Some(hwnd);
        }
        SOURCE.store(FROM_NONE, Ordering::Relaxed);
        if !MISSING_LOGGED.swap(true, Ordering::Relaxed) {
            fh_core::logutil::write_line(
                "topmost: no window handle from either path — topmost/foreground steps skipped",
            );
        }
        None
    }

    /// 本进程最大的那个顶层窗口（就是浮层自己）。
    ///
    /// 同进程里还有**系统给的单实例消息窗口**（0×0），按面积排序天然排在最后 —— 与启动器
    /// `overlay_watch.rs` 里 `looks_like_overlay` 同一个道理：别把那个隐形窗口当成浮层。
    fn own_top_level() -> Option<HWND> {
        struct Pick {
            pid: u32,
            hwnd: HWND,
            area: i64,
        }
        unsafe extern "system" fn each(hwnd: HWND, param: LPARAM) -> i32 {
            let pick = &mut *(param as *mut Pick);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != pick.pid {
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
            if area > pick.area {
                pick.hwnd = hwnd;
                pick.area = area;
            }
            1
        }
        let mut pick = Pick {
            pid: unsafe { GetCurrentProcessId() },
            hwnd: std::ptr::null_mut(),
            area: 0,
        };
        unsafe {
            EnumWindows(Some(each), &mut pick as *mut Pick as LPARAM);
        }
        (!pick.hwnd.is_null() && pick.area > 0).then_some(pick.hwnd)
    }

    /// 失败才读 `GetLastError`：**成功**的调用不会清掉它，无条件读会读回别的调用的旧错误，
    /// 日志里就会出现「ok=true err=183」这种自相矛盾的行。
    unsafe fn err_of(ok: i32) -> u32 {
        if ok == 0 {
            GetLastError()
        } else {
            0
        }
    }

    /// 断开 owner：浮层的 owner 是主窗，有 owner 的窗口 z 序要跟着 owner 排，
    /// 浮不到全屏窗口上面去。
    ///
    /// 只在**确实有 owner** 时才动手：本来就没有 owner 时这次调用什么都没改，而
    /// `SetWindowLongPtrW` 的返回值在「原值是 0」时也是 0，分不出成功还是失败 ——
    /// 用 `SetLastError(0)` + 事后查错误码的办法才能判得准，也就顺带把结果记进日志。
    pub fn detach_owner(window: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(window) else {
            return;
        };
        unsafe {
            if GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT) == 0 {
                return;
            }
            SetLastError(0);
            SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
            let err = GetLastError();
            if err != 0 {
                fh_core::logutil::write_line(&format!("topmost: detach owner failed err={err}"));
            }
        }
    }

    /// 推到置顶层最上面，并把 `WS_EX_TOPMOST` / `WS_EX_TOOLWINDOW` 直接写进扩展样式。
    ///
    /// `SetWindowPos` 会**静默失败**（例如被 UIPI 挡下：普通权限的进程动不了提权进程的
    /// 前台窗口），所以这里显式查返回值 —— 0.1.48 只写了 `WS_EX_TOPMOST` 就以为万事大吉，
    /// 真机上那一步到底成没成，日志里看不出来。
    pub fn force_topmost(window: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(window) else {
            return;
        };
        unsafe {
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
            SetWindowLongW(
                hwnd,
                GWL_EXSTYLE,
                ex | WS_EX_TOPMOST as i32 | WS_EX_TOOLWINDOW as i32,
            );
            let ok = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
            if ok == 0 {
                fh_core::logutil::write_line(&format!(
                    "topmost: SetWindowPos(TOPMOST) failed err={}",
                    err_of(ok)
                ));
            }
        }
    }

    /// 真抢前台。后台进程直接 `SetForegroundWindow` 会被前台锁挡掉（只闪任务栏、不报错），
    /// 所以先补一次 `VK_MENU` 的按下/抬起把锁解开 —— 启动器里用了很久的老办法。
    /// 抢不到不算致命（置顶的窗口没有前台也看得见），但**必须留话**：0.1.48 这里失败时
    /// 一样是静默的，日志里看不出前台到底在谁手上。
    pub fn steal_foreground(window: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(window) else {
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
            if GetForegroundWindow() != hwnd {
                fh_core::logutil::write_line(&format!(
                    "topmost: foreground still {} (steal didn't take)",
                    describe(GetForegroundWindow())
                ));
            }
        }
    }

    /// 自检：`IsWindowVisible` + 扩展样式里的 `WS_EX_TOPMOST`。
    /// 两件都成立才叫「系统看来它该在屏上、而且落在置顶层」；肉眼可见与否还要靠 `probe`。
    pub fn on_top(window: &WebviewWindow) -> bool {
        let Some(hwnd) = hwnd_of(window) else {
            return false;
        };
        unsafe {
            IsWindowVisible(hwnd) != 0
                && GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST != 0
        }
    }

    /// 一行现场：句柄来源 + 可见性 + 前台窗口 + 我们的置顶位/真实矩形 + 压在我们上面的可见窗口。
    /// `above` 里出现 `FantasyHub` 就是被全屏启动器压住；`topmost=false` 说明置顶没写进去；
    /// `fg=true` 说明前台也抢到了；`hwnd=none` 说明连句柄都没拿到（置顶那几步全是空操作）。
    /// 四种症状对应四种修法，别再靠猜。**拿不到句柄也返回 `Some`**，这一行不许消失。
    pub fn probe(window: &WebviewWindow) -> Option<String> {
        let Some(hwnd) = hwnd_of(window) else {
            return Some(format!(
                "hwnd={} visible=? — no handle, nothing to inspect",
                source_name()
            ));
        };
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
                "hwnd={} visible={} | fg={} | ours topmost={} fg={} rect={},{} {}x{} | above={}",
                source_name(),
                IsWindowVisible(hwnd) != 0,
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
