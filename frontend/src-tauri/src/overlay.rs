//! 浮层的显示/隐藏与定位。
//!
//! 这里**只关心自己的窗口**：没有「启动器是否在前台」这种跨程序状态，
//! 所以不会出现 0.1.45 那种「窗口在屏上、状态却是关的、于是关不掉」的组合。
//!
//! **「showed」不等于「看得见」**（0.1.50）：Tauri 的 `is_visible()` 只是在问「系统认为这个
//! 窗口可见没有」——被整屏窗口压住时它照样返回 true，日志就成了一路正常而人看不见。
//! 所以每次显示都多走一段：**自检 → 必要时重试 → 无条件留现场**（一行 `frontend layer …`
//! 告诉 Z 序和前台在谁手上，一张 `overlay-shot.bmp` 告诉屏幕那一片到底是什么）。
//! 这一段在后台线程里跑，见 `settle`；动手的 Win32 部分在 `topmost.rs` / `shot.rs`。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const WINDOW_LABEL: &str = "main";

/// 贴右浮层的逻辑宽度，乘缩放系数得物理宽度，与启动器原来的浮层保持一致。
const WIDTH_LOGICAL: f64 = 440.0;

/// 打开时是否抢焦点：抢了键盘/方向键才能用，不抢就只有手柄能操作（FRONTEND.md §3）。
/// 阶段 3/4 接上共享设置文件后改成可配置项。
const TAKE_FOCUS: bool = true;

/// 自检重试几次、每次间隔多久：窗口刚 show 出来时 DWM 还要一帧，立刻问可能是假阴性；
/// 5 × 120 ms 足够覆盖这个延迟，又短到用户察觉不出来。
const RETRY_MAX: u32 = 5;
const RETRY_GAP_MS: u64 = 120;

/// 上屏之后的「看护」：再盯这么久，被压回去就再顶一次（0.1.53）。
/// 8 × 350 ms ≈ 2.8 秒，正好覆盖「大屏模式里那个全屏的壳把浮层又压回去」这段窗口期；
/// 正常情况下一轮都不会触发，只是几条 `on_top` 查询。
const WATCH_TRIES: u32 = 8;
const WATCH_GAP_MS: u64 = 350;

static VISIBLE: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

/// 「第几次显示」：每次显示 / 隐藏都加一。后台的自检线程据此判断自己那一轮是否还有效 ——
/// 否则用户快速开关两次时，前一轮的收尾会对着已经关掉的窗口继续动作（而它的重试带着
/// `SWP_SHOWWINDOW`，会把窗口又显示出来）。
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// 手柄轮询每 40 ms 问一次，走这个便宜的静态判断；
/// **决定**开还是关请用 `toggle`，它问的是窗口本身（见下）。
pub fn is_visible() -> bool {
    VISIBLE.load(Ordering::SeqCst)
}

/// 真相只有一个：窗口自己的 `is_visible()`。静态的 `VISIBLE` 只是缓存。
fn window_visible(app: &AppHandle) -> Option<bool> {
    app.get_webview_window(WINDOW_LABEL)?.is_visible().ok()
}

/// 托盘点了退出：让手柄轮询线程自己收工。
pub fn request_quit() {
    QUITTING.store(true, Ordering::SeqCst);
}

pub fn toggle(app: &AppHandle, reason: &str) {
    // 这里曾经只看静态标记，于是「按了没反应」有了一个隐蔽的来源：只要有一次
    // show() 没真把窗口显示出来，标记就已经变成 true，之后每次按键都在做 hide()。
    // 现在每次都问窗口：它说在屏上才关，否则开。
    let visible = window_visible(app).unwrap_or_else(is_visible);
    // **「系统说可见」不等于「人看得见」**（0.1.53 真机结论）：大屏模式（FSE）下浮层
    // 常常已经 `show()` 成功、`is_visible()` 也是 true，却被铺满整屏的启动器压在下面 ——
    // 这时按第二次会走 `hide`，于是「桌面模式正常、大屏模式呼不出来」，而用户那边
    // 看到的是「按了完全没反应」。真机日志里那次 show 紧跟一次 hide 就是这么来的。
    // 判据再加上「真的落在置顶层」（`topmost::on_top`）：**可见但被压住 → 再顶一次，绝不 hide**。
    let on_top = app
        .get_webview_window(WINDOW_LABEL)
        .map(|window| crate::topmost::on_top(&window))
        .unwrap_or(true);
    if visible && on_top {
        hide(app, reason);
    } else {
        if visible {
            fh_core::logutil::write_line(&format!(
                "frontend visible but buried → re-raise instead of hide ({reason})"
            ));
        }
        show(app, reason);
    }
}

pub fn show(app: &AppHandle, reason: &str) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        fh_core::logutil::write_line(&format!("frontend show failed: no window ({reason})"));
        return;
    };
    // 把窗口**实际加载的页面**记下来：0.1.46 的前端窗口因为配置里没写 `url`，
    // 生产包里加载的是 index.html（启动器那一页）—— 一行日志就能看穿。
    let url = window
        .url()
        .map(|u| u.to_string())
        .unwrap_or_else(|_| "?".into());
    fh_core::logutil::write_line(&format!("frontend show begin ({reason}) url={url}"));
    place(&window, app);
    if let Err(err) = window.set_always_on_top(true) {
        fh_core::logutil::write_line(&format!("frontend always-on-top failed: {err}"));
    }
    // 大屏模式（FSE）下 Tauri 的置顶不够：全屏的启动器是前台窗口，它的前台锁
    // 会让后台进程的 show()/set_focus() 静默失败，窗口就永远压在启动器下面 ——
    // 「桌面模式正常、大屏模式呼不出来」是 0.1.33 记过的老账，见 topmost.rs。
    crate::topmost::prepare(&window);
    // 以前这里的返回值被吞了：窗口没出来，日志却照样写着 "frontend shown"，
    // 现场只剩「按了没反应」。现在失败要留话，成功也要把真实可见性写回来。
    if let Err(err) = window.show() {
        fh_core::logutil::write_line(&format!("frontend show failed ({reason}): {err}"));
    }
    // 显示之后再顶一次并抢前台（与 0.1.45 经掌机验证的顺序一致）。
    crate::topmost::grab(&window);
    if TAKE_FOCUS {
        if let Err(err) = window.set_focus() {
            fh_core::logutil::write_line(&format!("frontend focus failed: {err}"));
        }
    }
    let visible = window_visible(app).unwrap_or(true);
    VISIBLE.store(visible, Ordering::SeqCst);
    fh_core::logutil::write_line(&format!("frontend show end ({reason}) is_visible={visible}"));
    if !visible {
        // 说了要显示却还是不可见：把窗口的真实位置/尺寸记下来，否则现场只剩一句「没反应」。
        let pos = window
            .outer_position()
            .map(|p| format!("{},{}", p.x, p.y))
            .unwrap_or_else(|_| "?".into());
        let size = window
            .outer_size()
            .map(|s| format!("{}x{}", s.width, s.height))
            .unwrap_or_else(|_| "?".into());
        fh_core::logutil::write_line(&format!("frontend still hidden: pos={pos} size={size}"));
    }
    // 收尾（自检 / 重试 / 留现场）交给后台线程：`show()` 也会从托盘菜单、第二实例的回调里
    // 被调用，那些都在**主线程**上，在这里连等 5 × 120 ms 会把界面冻住。
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    settle(window, reason.to_string(), generation);
}

/// 显示之后的收尾：**自检 → 必要时重试 → 无条件留现场**。
///
/// 「无条件」是这一版的重点：0.1.48 把现场快照挂在 `if let Some(..)` 上，而那条路径在真机上
/// 一次都没打印出来 —— 于是既不知道 Z 序、也不知道前台还在不在我们手上，更没有像素证据。
/// 现在自检结果、Z 序快照和截屏**每次都写**，成败都写。
///
/// 重试用 `retry_top`（能再顶一次置顶，但**不碰前台锁**）：它带 `SWP_SHOWWINDOW`，所以在
/// 真正动手之前先确认「这一轮还算数」（`GENERATION`）并且「窗口现在还是开着的」。
fn settle(window: WebviewWindow, reason: String, generation: u64) {
    std::thread::spawn(move || {
        let current = || GENERATION.load(Ordering::SeqCst) == generation;
        let mut on_top = false;
        for attempt in 1..=RETRY_MAX {
            if !current() {
                return;
            }
            on_top = crate::topmost::on_top(&window);
            if on_top || attempt == RETRY_MAX {
                break;
            }
            // 用户可能正好在这一刻把它关掉：`force_topmost` 带着 `SWP_SHOWWINDOW`，
            // 对着已经隐藏的窗口调用会把它又显示出来（0.1.45 的老坑）。先问一句。
            if !window.is_visible().unwrap_or(true) {
                return;
            }
            fh_core::logutil::write_line(&format!(
                "frontend show retry {attempt}/{RETRY_MAX} ({reason}): not on top yet"
            ));
            crate::topmost::retry_top(&window);
            std::thread::sleep(std::time::Duration::from_millis(RETRY_GAP_MS));
        }
        if !current() {
            return;
        }
        // 0.1.53：重试用尽还是没进置顶层 → 上最硬的一下（抢前台 + 再顶），再看一眼结果。
        // 大屏模式里「顶了但被那个全屏的壳压回来」是最难猜的现场，这一行日志直接说结论。
        if !on_top {
            fh_core::logutil::write_line(&format!(
                "frontend not on top after {RETRY_MAX} retries ({reason}) — hard raise"
            ));
            crate::topmost::hard_raise(&window);
            on_top = crate::topmost::on_top(&window);
        }
        let layer =
            crate::topmost::probe(&window).unwrap_or_else(|| "probe unavailable".to_string());
        fh_core::logutil::write_line(&format!("frontend layer ({reason}) on_top={on_top} {layer}"));
        match crate::shot::capture(&window) {
            Ok(note) => fh_core::logutil::write_line(&format!("frontend shot ok {note}")),
            Err(err) => fh_core::logutil::write_line(&format!("frontend shot failed: {err}")),
        }
        // 最后再盯几秒：被人压回去就再顶（日志放在现场快照之后，所以截的是**被压住的那一刻**，
        // 那正是最需要看的画面）。
        keep_on_top(&window, &current, &reason);
    });
}

/// 上屏之后的一段看护：被压回去就再顶一次，最多 [`WATCH_TRIES`] 轮。
///
/// 为什么需要（0.1.53）：用户的原话是「桌面模式能唤出、大屏（FSE）唤不出，切回桌面又可以」——
/// 这说明前端进程活着，只是浮层上不去。启动器那边现在会**常态让位**
/// （`overlay_watch::BIG_SCREEN`），正常情况下这里一轮都不会触发；一旦触发，日志会留下
/// 「buried again」这几行，下一次真机排查不用再猜是谁压的。
///
/// 日志只在头 3 次写：8 轮全失败时刷 8 行没有额外信息量。
fn keep_on_top(window: &WebviewWindow, current: &impl Fn() -> bool, reason: &str) {
    let mut logged = 0;
    for _ in 0..WATCH_TRIES {
        std::thread::sleep(std::time::Duration::from_millis(WATCH_GAP_MS));
        if !current() {
            return;
        }
        // 用户可能正好在这一刻把它关掉：再顶会带着 `SWP_SHOWWINDOW` 把它又显示出来
        // （0.1.45 的老坑）。先问一句。
        if !window.is_visible().unwrap_or(true) {
            return;
        }
        if crate::topmost::on_top(window) {
            continue;
        }
        if logged < 3 {
            logged += 1;
            fh_core::logutil::write_line(&format!(
                "frontend buried again after show ({reason}) — re-raise {logged}"
            ));
        }
        crate::topmost::hard_raise(window);
    }
}

pub fn hide(app: &AppHandle, reason: &str) {
    // 让还在跑的那轮自检作废：它的重试带着 `SWP_SHOWWINDOW`，别把刚关掉的窗口又显示出来。
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if let Err(err) = window.hide() {
            fh_core::logutil::write_line(&format!("frontend hide failed: {err}"));
        }
    }
    let visible = window_visible(app).unwrap_or(false);
    VISIBLE.store(visible, Ordering::SeqCst);
    fh_core::logutil::write_line(&format!("frontend hide end ({reason}) is_visible={visible}"));
}

/// 贴右、置顶、整屏高。
///
/// 定位先问主显示器、再问窗口自己：对一个还隐藏着的窗口调 `current_monitor()`
/// 在独占全屏下会卡住（启动器里踩过这个坑），所以后者只当兜底。
fn place(window: &WebviewWindow, app: &AppHandle) {
    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        fh_core::logutil::write_line("frontend place: no monitor");
        return;
    };
    let screen = monitor.size();
    let origin = monitor.position();
    let scale = monitor.scale_factor();
    let width = ((WIDTH_LOGICAL * scale).round() as u32)
        .max(320)
        .min(screen.width);
    let height = screen.height;
    let x = origin.x + screen.width.saturating_sub(width) as i32;
    let y = origin.y;
    fh_core::logutil::write_line(&format!(
        "frontend place x={x} y={y} w={width} h={height} scale={scale}"
    ));
    let _ = window.set_size(tauri::Size::Physical(PhysicalSize { width, height }));
    let _ = window.set_position(tauri::Position::Physical(PhysicalPosition { x, y }));
}

/// 关窗永远只是隐藏：前端是托盘常驻软件，真正退出只能走托盘菜单。
pub fn attach_window_events(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            hide(&handle, "close requested");
        }
    });
}
