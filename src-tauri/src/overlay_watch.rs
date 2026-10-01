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

use std::sync::atomic::{AtomicBool, Ordering};

/// 现在的状态：浮层在屏上（`overlay-state` 事件的当前值，也供 `overlay_open` 命令回答）。
static OPEN: AtomicBool = AtomicBool::new(false);

/// 前端主程序的文件名，来自 `frontend/src-tauri/tauri.conf.json` 的 `mainBinaryName`。
/// 按**完整文件名**比对：启动器自己叫 `FantasyHub.exe`，是它的前缀 —— 用「包含」判断会
/// 把启动器自己也算进去。
#[cfg(windows)]
const FRONTEND_EXE: &str = "FantasyHubFrontend.exe";

/// 轮询间隔。大屏模式（FSE）与桌面模式共用同一套判断。
#[cfg(windows)]
const POLL_MS: u64 = 200;

/// 界面挂载时问一次，省得漏掉「页面加载时浮层已经开着」这种边角。
#[tauri::command]
pub fn overlay_open() -> bool {
    OPEN.load(Ordering::SeqCst)
}

#[cfg(windows)]
pub fn start(app: tauri::AppHandle) {
    use tauri::Emitter;

    std::thread::spawn(move || {
        // 找到过的句柄：前端重启会换句柄，失效了再去找（见 `watch`）。
        let mut cached = 0isize;
        let mut known = false;
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
                let _ = app.emit("overlay-state", open);
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
            // 找的就是可见的顶层窗口，所以找到即「在屏上」。
            true
        }
        None => false,
    }
}

/// 找「属于前端主程序的可见顶层窗口」。找不到 = 浮层没在屏上。
#[cfg(windows)]
fn find_overlay() -> Option<windows_sys::Win32::Foundation::HWND> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
    };

    // 前端的窗口**一直存在**（开局 `visible: false`，关掉只是 hide），所以「窗口在」不等于
    // 「在屏上」—— 只认可见的。`EnumWindows` 只回调顶层窗口，浮层就是顶层窗口。
    unsafe extern "system" fn each(hwnd: HWND, param: LPARAM) -> i32 {
        let found = &mut *(param as *mut Option<HWND>);
        if found.is_some() {
            return 0;
        }
        if IsWindowVisible(hwnd) == 0 {
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
