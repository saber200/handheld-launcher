//! 独立前端的浮层是不是正显示在屏上 —— 启动器据此决定「手柄这会儿归谁」。
//!
//! 为什么要有这道闸：手柄是**共享资源**。XInput 每个进程都能只读轮询，Windows 不给
//! 「独占」，而启动器界面用 Gamepad API 读的正是**同一份**手柄状态。浮层开着时启动器的
//! 方向键 / A 键会**同时**作用在身后的界面上（A 甚至会在背后把游戏启动起来）。
//! 完整规则（谁在什么时候吃手柄）见仓库根 `FRONTEND.md` §10。
//!
//! 判定用**可见性**，不用焦点：FRONTEND.md §3 说浮层的 `TAKE_FOCUS` 以后要变成设置项，
//! 浮层「不抢焦点」时焦点判断正好会失灵；「浮层在屏上」才是「谁该用手柄」的语义。
//!
//! 为什么由启动器自己看窗口，而不是让前端上报（新 IPC 命令 / 写进 `frontend.json`）：
//! 那要动前端 → 两个程序必须同时升级，老前端不写就没信号；前端被杀 / 崩溃之后状态还会
//! 「卡在开着」，启动器的手柄就永久失灵。看窗口对**已经装好的前端立刻生效**，前端退出即
//! 自动复位，也不给「前端 → 启动器」加新通道（FRONTEND.md §2 的边界）：这里只读窗口
//! 列表，不读写对方任何东西。
//!
//! 200 ms 一轮：浮层切换后手柄最多晚 200 ms 回到启动器，而人打开浮层之后再伸手柄至少要
//! 几百毫秒，够用。**只在状态变化时记日志**，否则 5 轮/秒会把日志刷爆。
//!
//! 开销：前端在跑时每轮只问一个句柄（几次系统调用）；前端完全没在跑时每轮要枚举一遍顶层
//! 窗口（百次级系统调用，200 ms 一次，量级可以忽略）。
//!
//! **「可见」不等于「像浮层」**（0.1.50 修）：前端程序里还有**系统给的另一个窗口** ——
//! `tauri-plugin-single-instance` 为了收「又启动了一次」的消息会 `CreateWindowExW` 一个
//! 0×0 的窗口，样式是 `WS_VISIBLE | WS_POPUP` + `WS_EX_NOACTIVATE | WS_EX_TRANSPARENT |
//! WS_EX_LAYERED | WS_EX_TOOLWINDOW`。它 `IsWindowVisible()` **为真**、也属于前端程序，
//! 于是「可见 + 属于前端」两条判据在前端一开机就成立：浮层明明关着，启动器却把手柄让出去，
//! 而且**永久**让出去（那条窗口不会消失）。所以判据必须是形状：浮层是 660×1200 的实心
//! 顶层窗口，那个是 0×0 的点击穿透窗口 —— 见 `looks_like_overlay`。
//!
//! 这个观察线程还顺带干一件**跨程序**的活儿：看到浮层真的上屏，壳体自己让位、并**替浮层**
//! 把它顶到最前（见 `stand_back`）。理由在 UIPI：开机自启时启动器是提权的、前端是普通
//! 权限，低完整性进程**排不到**高完整性窗口上面，而且失败不报错 —— 让有权限的一方动手，
//! 方向永远是允许的那一侧。

use std::sync::atomic::{AtomicBool, Ordering};

/// 现在的状态：浮层在屏上（`overlay-state` 事件的当前值，也供 `overlay_open` 命令回答）。
static OPEN: AtomicBool = AtomicBool::new(false);

/// 现在是不是**大屏模式（FSE）**：由 `startup.rs` 在切换模式时写入。
///
/// 为什么要这个东西（0.1.53 真机结论）：大屏模式下启动器是**铺满整屏的前台窗口**，而浮层
/// 不一定排在它上面 —— UIPI 规定低完整性进程排不到高完整性窗口上面，而安装器拉起的前端
/// 与启动器权限还不一定一致。0.1.50 的 `stand_back` 只在「看到浮层真的上屏」那一刻让位，
/// 真机上仍然会出现「按键没反应」。所以大屏模式里**常态就让位**：壳体根本不进置顶层，
/// 浮层一出来就自然在它上面。回到桌面模式再把壳体原来的样子还回去。
static BIG_SCREEN: AtomicBool = AtomicBool::new(false);

/// 大屏模式开始时壳体是不是置顶的：回到桌面模式时按原样还回去，不凭空给它加置顶。
#[cfg(windows)]
static SHELL_WAS_TOPMOST: AtomicBool = AtomicBool::new(false);

/// 切换大屏 / 桌面模式时调一次（`startup.rs`）。**立刻生效**，不等下一轮 200 ms 轮询 ——
/// 用户是在按下 Back+Start 的前一秒才切模式的，让它「等 200 毫秒再说」正是那类玄学 bug。
pub fn set_big_screen(on: bool) {
    if BIG_SCREEN.swap(on, Ordering::SeqCst) == on {
        return;
    }
    fh_core::logutil::write_line(&format!("overlay watch: big-screen mode = {on}"));
    #[cfg(windows)]
    shell_follow_mode(on);
}

/// 大屏模式：壳体退出置顶层（让浮层能被顶上来）；回到桌面：还回原来的样子。
/// 由提权的启动器动手 —— UIPI 允许高完整性进程改写低完整性窗口的 Z 序，反过来不行。
#[cfg(windows)]
fn shell_follow_mode(big_screen: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowPos, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST,
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOPMOST,
    };

    let Some(shell) = own_shell_window() else {
        fh_core::logutil::write_line("overlay yield: no shell window (mode change)");
        return;
    };
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
    unsafe {
        let topmost_now = GetWindowLongW(shell, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST != 0;
        if big_screen {
            SHELL_WAS_TOPMOST.store(topmost_now, Ordering::SeqCst);
            if topmost_now {
                let ok = SetWindowPos(shell, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
                fh_core::logutil::write_line(&format!(
                    "overlay yield: shell notopmost for big-screen ok={} err={}",
                    ok != 0,
                    err_of(ok)
                ));
            }
        } else if SHELL_WAS_TOPMOST.swap(false, Ordering::SeqCst) {
            let ok = SetWindowPos(shell, HWND_TOPMOST, 0, 0, 0, 0, flags);
            fh_core::logutil::write_line(&format!(
                "overlay yield: shell topmost back after big-screen ok={} err={}",
                ok != 0,
                err_of(ok)
            ));
        }
    }
}

/// 壳体现在是不是该退出置顶层（大屏模式下为真）。
/// `stand_back` 的「收尾还原」分支要用它：大屏模式里不能把置顶还回去，
/// 否则下一次浮层出来又得靠那一刻的让位去抢，回到同一个老问题。
#[cfg(windows)]
fn big_screen() -> bool {
    BIG_SCREEN.load(Ordering::SeqCst)
}

/// 前端主程序的文件名，来自 `frontend/src-tauri/tauri.conf.json` 的 `mainBinaryName`。
/// 按**完整文件名**比对：启动器自己叫 `FantasyHub.exe`，是它的前缀 —— 用「包含」判断会
/// 把启动器自己也算进去。
#[cfg(windows)]
pub(crate) const FRONTEND_EXE: &str = "FantasyHubFrontend.exe";

/// 轮询间隔。大屏模式（FSE）与桌面模式共用同一套判断。
#[cfg(windows)]
const POLL_MS: u64 = 200;

/// 浮层的**最小**边长（物理像素）：用来把「系统给前端程序的那个 0×0 隐形窗口」挡在外面。
/// 浮层实际是 660×1200（1920 宽屏 @150% 贴右整高），阈值取 160 是给缩放系数留足余地，
/// 同时离 0 足够远 —— 判据是「有真实尺寸」而不是「正好这个尺寸」。
#[cfg(windows)]
const MIN_SIDE: i32 = 160;

/// 界面挂载时问一次，省得漏掉「页面加载时浮层已经开着」这种边角。
#[tauri::command]
pub fn overlay_open() -> bool {
    OPEN.load(Ordering::SeqCst)
}

#[cfg(windows)]
pub fn start(app: tauri::AppHandle) {
    use tauri::Emitter;
    use windows_sys::Win32::Foundation::HWND;

    std::thread::spawn(move || {
        // 找到过的句柄：前端重启会换句柄，失效了再去找（见 `watch`）。
        let mut cached = 0isize;
        let mut known = false;
        // 壳体原本是不是置顶的：只在浮层上来时让位，浮层走了按原样还回去（见 `stand_back`）。
        let mut shell_was_topmost: Option<bool> = None;
        // 前端**进程**在不在 —— 和「浮层在不在屏上」是两件事，但它是「按键有没有人接」的前提。
        // 0.1.50 的真机日志正卡在这里：前端起来之后一条记录都没有，分不清它是没在跑、崩了，
        // 还是按键没进来（三种情况的下一步完全不同）。每 5 秒扫一次（200 ms 一轮 × 25），
        // 只在状态变化时记一行 —— 第一轮也会记，所以「日志里没有这一行」本身就是异常。
        let mut frontend_up: Option<bool> = None;
        // 「这一轮没查成」也要和「没在跑」分开（0.1.52）：0.1.51 的日志只有一句 `down`，
        // 万一是快照没建起来，就会被读成「前端真的没了」。查不成时**不动状态**、只记原因。
        let mut scan_error: Option<String> = None;
        let mut ticks: u32 = 0;
        loop {
            let open = watch(&mut cached);
            if open != known {
                known = open;
                OPEN.store(open, Ordering::SeqCst);
                fh_core::logutil::write_line(&format!(
                    "overlay watch: frontend overlay {} → launcher pad {}",
                    if open { "visible" } else { "hidden" },
                    if open { "off" } else { "on" }
                ));
                // 「认的是哪个窗口」也记下来：0.1.49 就是在这儿认错了窗口，而日志只说了
                // 「浮层可见」，没法回看它到底认了谁。
                if open {
                    fh_core::logutil::write_line(&format!(
                        "overlay target: {}",
                        describe(cached as HWND)
                    ));
                }
                stand_back(open, cached as HWND, &mut shell_was_topmost);
                let _ = app.emit("overlay-state", open);
            }
            ticks += 1;
            if ticks % 25 == 0 {
                let scan = frontend_scan();
                if let Some(error) = scan.error {
                    // 没查成：状态**不动**（宁可沿用上一次判断），同一原因只记一次。
                    if scan_error.as_deref() != Some(error.as_str()) {
                        fh_core::logutil::write_line(&format!(
                            "overlay watch: frontend process scan failed: {error}（这一轮没查成，不代表它没在跑）"
                        ));
                        scan_error = Some(error);
                    }
                } else {
                    if scan_error.take().is_some() {
                        fh_core::logutil::write_line("overlay watch: frontend process scan ok again");
                    }
                    let up = scan.frontend.is_some();
                    if frontend_up != Some(up) {
                        frontend_up = Some(up);
                        fh_core::logutil::write_line(&match scan.frontend {
                            Some(pid) => format!("overlay watch: frontend process up (pid={pid})"),
                            // 报「没在跑」时把在场的关系进程一起写出来：真要出现
                            // `FantasyHubFrontend.exe`，就是判据出了问题；只有启动器自己，
                            // 则是前端确实不在 —— 这一行省掉一整轮真机排查。
                            None => format!(
                                "overlay watch: frontend process down（前端没在跑：Back+Start 不会有反应；相关进程：{}）",
                                if scan.related.is_empty() {
                                    "一个都没有".to_string()
                                } else {
                                    scan.related.join(" ")
                                }
                            ),
                        });
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        }
    });
}

/// 非 Windows 没有这套，也没有第二个程序来抢手柄：只留签名，方便本机 `cargo check`
/// （与 `frontend/src-tauri/src/topmost.rs` 同一套做法）。
#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle) {}

/// 一轮检查：记住的句柄先确认「还在、还属于前端程序」，再问它可见不可见（5 次系统调用）；
/// 句柄没了（前端退出 / 重启）才重新枚举顶层窗口。
///
/// 为什么要连「还属于前端程序」一起确认：窗口句柄会被系统回收，只认句柄的话可能盯着一个
/// 碰巧复用了同一句柄的别的窗口 —— 手柄就会莫名其妙地失灵或反过来继续漏。
#[cfg(windows)]
fn watch(cached: &mut isize) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, IsWindow, IsWindowVisible,
    };

    if *cached != 0 {
        let hwnd = *cached as HWND;
        let mut pid = 0u32;
        if unsafe { IsWindow(hwnd) } != 0 {
            unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        }
        if pid != 0 && is_frontend_process(pid) {
            return unsafe { IsWindowVisible(hwnd) } != 0;
        }
        *cached = 0;
    }
    match find_overlay() {
        Some(hwnd) => {
            *cached = hwnd as isize;
            // 找的就是「可见 + 形状像浮层」的顶层窗口，所以找到即「在屏上」。
            true
        }
        None => false,
    }
}

/// 找「属于前端主程序、并且长得像浮层」的顶层窗口。找不到 = 浮层没在屏上。
#[cfg(windows)]
fn find_overlay() -> Option<windows_sys::Win32::Foundation::HWND> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};

    // 前端的窗口**一直存在**（开局 `visible: false`，关掉只是 hide），所以「窗口在」不等于
    // 「在屏上」—— 只认可见的；而「可见」还不够，前端程序里还有系统给的 0×0 隐形窗口，
    // 见 `looks_like_overlay`。`EnumWindows` 只回调顶层窗口，浮层就是顶层窗口。
    unsafe extern "system" fn each(hwnd: HWND, param: LPARAM) -> i32 {
        let found = &mut *(param as *mut Option<HWND>);
        if found.is_some() {
            return 0;
        }
        if !looks_like_overlay(hwnd) {
            return 1;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != 0 && is_frontend_process(pid) {
            *found = Some(hwnd);
            return 0;
        }
        1
    }

    let mut found: Option<HWND> = None;
    unsafe {
        EnumWindows(Some(each), &mut found as *mut Option<HWND> as LPARAM);
    }
    found
}

/// 这个窗口像不像「画在屏上的浮层」。
///
/// 为什么不能只判「可见 + 属于前端程序」：前端程序里除了浮层，还有一个**系统给的隐形窗口**
/// （`tauri-plugin-single-instance` 的 `-sic` 消息窗口：0×0、`WS_VISIBLE|WS_POPUP`、
/// `WS_EX_TRANSPARENT|WS_EX_LAYERED|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW`）。它
/// `IsWindowVisible()` 为真，前端一开机就把前两条判据凑齐了 —— 0.1.49 的手柄因此永久失灵。
///
/// 判据（任一条不满足就不是浮层）：
/// - `IsWindowVisible`：关掉的浮层只是 hide，不可见；那个隐形窗口在这里就已经被筛掉了？不，
///   它是「可见」的 —— 所以下面几条才是关键。
/// - **不是点击穿透**（`WS_EX_TRANSPARENT`）：浮层要收点击、键盘和手柄；那个隐形窗口正是
///   点击穿透的。
/// - **有真实尺寸**（≥ `MIN_SIDE` × `MIN_SIDE`）：隐形窗口是 0×0，浮层是 660×1200。
///   这一条单独就足以把它挡在外面，另外两条是顺手把「别的程序的辅助窗口」也排除掉。
/// - 没有 owner：有 owner 的窗口在 Z 序上跟着 owner 走，浮层不该有 owner。这条**安全**的前提
///   是前端每次显示都先 `detach_owner`（`topmost.rs`，`force_topmost` 带 `SWP_SHOWWINDOW`，
///   而清 owner 排在它前面）——所以浮层**从来没有带着 owner 出现在屏上**过。
#[cfg(windows)]
unsafe fn looks_like_overlay(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindow, GetWindowLongW, GetWindowRect, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
        WS_EX_TRANSPARENT,
    };

    if IsWindowVisible(hwnd) == 0 {
        return false;
    }
    if !GetWindow(hwnd, GW_OWNER).is_null() {
        return false;
    }
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TRANSPARENT != 0 {
        return false;
    }
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if GetWindowRect(hwnd, &mut rect) == 0 {
        return false;
    }
    rect.right - rect.left >= MIN_SIDE && rect.bottom - rect.top >= MIN_SIDE
}

/// 窗口 → `类名 "标题"(pid=…) rect=WxH ex=0x…`，只留一眼能认出来的长度。
/// 判错窗口时，这一行就是全部证据。
#[cfg(windows)]
fn describe(hwnd: windows_sys::Win32::Foundation::HWND) -> String {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, GWL_EXSTYLE, GW_OWNER,
    };

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
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        GetWindowRect(hwnd, &mut rect);
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let class = String::from_utf16_lossy(&class[..class_len.max(0) as usize]);
        let title = String::from_utf16_lossy(&title[..title_len.max(0) as usize]);
        // `owner=` 也写出来：万一哪天浮层被判据里的「无 owner」挡在外面，这一行就能直接解释。
        let owner = if GetWindow(hwnd, GW_OWNER).is_null() {
            "no"
        } else {
            "yes"
        };
        format!(
            "{class} \"{}\"(pid={pid}) rect={}x{} ex=0x{ex:08x} owner={owner}",
            tidy(&title),
            rect.right - rect.left,
            rect.bottom - rect.top
        )
    }
}

/// 标题清洗：控制字符和引号会破坏一行一条的日志格式。
#[cfg(windows)]
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

/// 本进程那个「铺满整屏的壳窗口」：自己 pid 的顶层可见窗口里面积最大的那个。
///
/// 为什么不用 `window.hwnd()`：这里跑在观察线程上，句柄取一次就够；枚举还顺手排除了本进程
/// 自己那个 0×0 的单实例消息窗口（和浮层那边的 `looks_like_overlay` 同一个道理）。
#[cfg(windows)]
fn own_shell_window() -> Option<windows_sys::Win32::Foundation::HWND> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
    };

    struct Pick {
        pid: u32,
        hwnd: HWND,
        area: i64,
    }
    unsafe extern "system" fn each(hwnd: HWND, param: LPARAM) -> i32 {
        let pick = &mut *(param as *mut Pick);
        if IsWindowVisible(hwnd) == 0 || !GetWindow(hwnd, GW_OWNER).is_null() {
            return 1;
        }
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

/// 失败才读 `GetLastError`：**成功**的调用不会清掉这个值，无条件读会读回别的调用的旧错误，
/// 日志里就会出现「ok=true err=183」这种自相矛盾的行。
#[cfg(windows)]
unsafe fn err_of(ok: i32) -> u32 {
    if ok == 0 {
        windows_sys::Win32::Foundation::GetLastError()
    } else {
        0
    }
}

/// 浮层在屏上时：壳自己让位，并**替浮层**把它顶到最前；浮层收起后按原样还回去。
///
/// 为什么由启动器来做这两下 —— UIPI：低完整性进程不能动高完整性进程的窗口（高 → 低可以）。
/// 开机自启时启动器是提权的（日志里的 `elevated=true`）、前端是普通权限，所以
/// **前端自己**的 `SetWindowPos(HWND_TOPMOST)` 有可能根本排不到整屏的壳上面，而且失败不报错。
/// 让有权限的一方动手，方向永远是允许的那一侧。这同时把 0.1.33 记的那条老账
/// （「全屏启动器压住浮层」，当年靠 `steal_foreground` 抢前台来绕）换成「壳自己让开」。
///
/// 边界（FRONTEND.md §2）：只动**自己窗口**和**目标浮层窗口**的 Z 序，不读写前端任何数据，
/// 也不给两个程序之间加通道 —— 这里仍然只用到"有个窗口在屏上"这一个事实。
#[cfg(windows)]
fn stand_back(
    open: bool,
    overlay: windows_sys::Win32::Foundation::HWND,
    shell_was_topmost: &mut Option<bool>,
) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowPos, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST,
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOPMOST,
    };

    let Some(shell) = own_shell_window() else {
        fh_core::logutil::write_line("overlay yield: no shell window");
        return;
    };
    // `SWP_ASYNCWINDOWPOS`：这两次调用都跨线程（窗口归主线程，这里跑在观察线程上），
    // 万一主线程正忙或卡住，同步调用会把**仲裁线程**一起拖住 —— 手柄归属就不响应了。
    // 加上它，请求直接投递、立刻返回（拿不到「结果」的代价在这一步可以接受，日志照样记）。
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
    unsafe {
        let topmost_now = GetWindowLongW(shell, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST != 0;
        // 第一次翻转时记下壳体原本的样子：只按原样恢复，不凭空给它加置顶。
        let original = *shell_was_topmost.get_or_insert(topmost_now);
        if open {
            let ok = SetWindowPos(shell, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
            fh_core::logutil::write_line(&format!(
                "overlay yield: shell notopmost ok={} err={}",
                ok != 0,
                err_of(ok)
            ));
            if !overlay.is_null() {
                let ok = SetWindowPos(overlay, HWND_TOPMOST, 0, 0, 0, 0, flags);
                fh_core::logutil::write_line(&format!(
                    "overlay raise: frontend topmost ok={} err={}",
                    ok != 0,
                    err_of(ok)
                ));
            }
        } else if original && !big_screen() {
            let ok = SetWindowPos(shell, HWND_TOPMOST, 0, 0, 0, 0, flags);
            fh_core::logutil::write_line(&format!(
                "overlay yield: shell topmost back ok={} err={}",
                ok != 0,
                err_of(ok)
            ));
        } else if original {
            // 大屏模式里**不**把置顶还回去：常态让位，浮层下次出来就自然在上面
            // （见 `BIG_SCREEN` 的说明）。回到桌面模式时由 `shell_follow_mode` 还回去。
            fh_core::logutil::write_line("overlay yield: keep notopmost (big-screen mode)");
        }
    }
}

/// 这个进程号的可执行文件名是不是前端主程序。
///
/// 提权的启动器读普通权限进程的映像是允许的（`PROCESS_QUERY_LIMITED_INFORMATION`，
/// 不需要 `PROCESS_VM_READ`）；系统进程读不了，读不到就当「不是」。
#[cfg(windows)]
fn is_frontend_process(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    // MAX_PATH 足够放下任何真实路径（超长路径带 `\\?\` 前缀，末尾那段文件名照样在最后）。
    let mut buffer = [0u16; 520];
    let mut size = buffer.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size)
    };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return false;
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    path.rsplit(['\\', '/'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case(FRONTEND_EXE))
}

/// 前端**进程**还在不在（按可执行文件名扫一遍进程表）。
///
/// 为什么不复用上面那套「按窗口找」：这里要的正是「前端可能连窗口都还没建」也要答对，
/// 进程扫描不依赖窗口存活；而且它不碰别的程序的状态，仍然是只读的（§2 的边界）。
/// 代价是一次 `CreateToolhelp32Snapshot` + 一次遍历，5 秒才做一次。名字比对规则与
/// `is_frontend_process` 完全一致（`FantasyHub.exe` 是它的前缀，必须整名相等）。
/// 一次进程扫描的结果。
///
/// 三件事必须能分开（0.1.52）：前端在跑（`frontend = Some(pid)`）、前端没在跑
/// （`frontend = None` 且 `error = None`）、**这一轮压根没查成**（`error = Some(..)`）。
/// 0.1.51 把后两者压成了一个 `false`，真机上万一快照没建起来，日志里就写成
/// 「前端没在跑」，把排查带偏一整轮。
#[cfg(windows)]
struct Scan {
    /// 前端进程的 pid；没在跑就是 `None`。
    frontend: Option<u32>,
    /// 镜像名里带 `fantasyhub` 的其他进程（去重、最多 4 条）。报「没在跑」时一起写进日志，
    /// 用来区分「前端真的不在」和「判据看漏了」。
    related: Vec<String>,
    /// 快照都没建起来时的原因。
    error: Option<String>,
}

/// 扫一遍进程表（只读）。名字比对规则与 `is_frontend_process` 完全一致：
/// `FantasyHub.exe`（启动器自己）是 `FantasyHubFrontend.exe` 的前缀，必须**整名相等**。
/// 代价是一次 `CreateToolhelp32Snapshot` + 一次遍历，5 秒才做一次。
#[cfg(windows)]
fn frontend_scan() -> Scan {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Scan {
            frontend: None,
            related: Vec::new(),
            error: Some(format!(
                "CreateToolhelp32Snapshot 失败（错误码 {}）",
                unsafe { GetLastError() }
            )),
        };
    }
    let mut scan = Scan {
        frontend: None,
        related: Vec::new(),
        error: None,
    };
    let mut entry = unsafe { std::mem::zeroed::<PROCESSENTRY32W>() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        // `szExeFile` 是定长数组 + `\0` 结尾，按第一个 0 截断（找不到 0 就用整个数组）。
        let end = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        let image = String::from_utf16_lossy(&entry.szExeFile[..end]);
        if image.eq_ignore_ascii_case(FRONTEND_EXE) {
            scan.frontend = Some(entry.th32ProcessID);
        } else if scan.related.len() < 4
            && image.to_ascii_lowercase().contains("fantasyhub")
            && !scan.related.iter().any(|item| item.eq_ignore_ascii_case(&image))
        {
            scan.related.push(image);
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    scan
}

/// 非 Windows 上没有这套（也没有第二个程序来抢手柄），本机 `cargo check` 也不编它。
#[cfg(windows)]
pub(crate) fn frontend_process_alive() -> bool {
    frontend_scan().frontend.is_some()
}
