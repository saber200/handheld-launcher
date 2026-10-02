//! 手柄：Back+Start 开关浮层，浮层打开时把摇杆/按键状态推给界面。
//!
//! XInput 是每进程只读轮询，多个程序同时看手柄互不影响 —— 但**也正因如此**，光靠
//! 「谁也读得到」并不能保证一次按键只有一个响应者：启动器的界面用 Gamepad API 读的是
//! 同一份状态，方向键 / A 键照样会响应。0.1.49 之前的现成症状就是两个：用 Back+Start
//! 呼出浮层时，和弦里的 Back 正好是启动器的设置键，设置抽屉会被一起拉开；浮层开着时
//! A 键还会在身后把游戏启动起来。
//!
//! 现在两边各让一步，规则写在仓库根 `FRONTEND.md` §10：启动器侧在浮层位于屏上时不消费
//! 手柄（`overlay_watch.rs` 观察窗口 + `useGamepadNav` 的 `viewGesture: "double"`），
//! 而和弦本身永远归前端 —— 浮层开关必须能独立工作（游戏里、启动器没跑时都要能用）。
//! 40 ms 一轮，与启动器里现成的实现同一个节奏：手感够用、也不烧 CPU。

/// 推给界面的手柄状态（事件名 `frontend-pad`，与旧版浮层的载荷同形状）。
#[derive(Default, Clone, serde::Serialize)]
struct PadState {
    dx: i8,
    dy: i8,
    a: bool,
    b: bool,
    start: bool,
}

#[cfg(windows)]
pub fn start(app: tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use tauri::{Emitter, Manager};

    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    fh_core::logutil::write_line("chord watch started (Back+Start)");
    std::thread::spawn(move || {
        use windows_sys::Win32::UI::Input::XboxController::{
            XInputGetState, XINPUT_GAMEPAD_A, XINPUT_GAMEPAD_B, XINPUT_GAMEPAD_BACK,
            XINPUT_GAMEPAD_DPAD_DOWN, XINPUT_GAMEPAD_DPAD_LEFT, XINPUT_GAMEPAD_DPAD_RIGHT,
            XINPUT_GAMEPAD_DPAD_UP, XINPUT_GAMEPAD_START, XINPUT_STATE,
        };

        // 摇杆推到多大才算方向（与启动器一致）。
        const DEADZONE: i32 = 16000;

        let mut held = false;
        // 手柄「在不在」：XInput 读到哪个 index 就算哪个在；组合键检查所有手柄。
        // 呼不出浮层时先排除这一条 —— 手柄读不到的话按键根本进不来，日志里只会是一片安静。
        // 初值给一个不可能的值（`u32::MAX`）：保证**第一轮**一定打印一条「读到 / 读不到」，
        // 从此「日志里什么都没有」这个状态只可能意味着「前端没在跑」。
        let mut pad_index: Option<u32> = Some(u32::MAX);
        // 5 分钟一条「我还活着」：足够回答「手柄轮询线程到底在不在转」。
        let mut heartbeat = std::time::Instant::now();
        while !crate::overlay::quitting() {
            let mut pressed = false;
            let mut pad = PadState::default();
            let mut alive: Option<u32> = None;
            for index in 0..4u32 {
                let mut state = unsafe { std::mem::zeroed::<XINPUT_STATE>() };
                if unsafe { XInputGetState(index, &mut state) } != 0 {
                    continue;
                }
                if alive.is_none() {
                    alive = Some(index);
                }
                let buttons = state.Gamepad.wButtons;
                if buttons & XINPUT_GAMEPAD_BACK != 0 && buttons & XINPUT_GAMEPAD_START != 0 {
                    pressed = true;
                }
                // 界面只在显示时才需要手柄状态，隐藏时省掉这次读取。
                if !crate::overlay::is_visible() {
                    continue;
                }
                let lx = state.Gamepad.sThumbLX as i32;
                let ly = state.Gamepad.sThumbLY as i32;
                let mut dx = 0i8;
                let mut dy = 0i8;
                if buttons & XINPUT_GAMEPAD_DPAD_LEFT != 0 || lx < -DEADZONE {
                    dx = -1;
                } else if buttons & XINPUT_GAMEPAD_DPAD_RIGHT != 0 || lx > DEADZONE {
                    dx = 1;
                }
                if buttons & XINPUT_GAMEPAD_DPAD_UP != 0 || ly > DEADZONE {
                    dy = -1;
                } else if buttons & XINPUT_GAMEPAD_DPAD_DOWN != 0 || ly < -DEADZONE {
                    dy = 1;
                }
                // First connected pad owns UI navigation; every pad may toggle.
                if alive == Some(index) {
                    pad = PadState {
                        dx,
                        dy,
                        a: buttons & XINPUT_GAMEPAD_A != 0,
                        b: buttons & XINPUT_GAMEPAD_B != 0,
                        start: buttons & XINPUT_GAMEPAD_START != 0,
                    };
                }
            }

            if alive != pad_index {
                pad_index = alive;
                fh_core::logutil::write_line(&match pad_index {
                    Some(index) => format!("chord pad connected index={index}"),
                    None => "chord pad none（读不到手柄：Back+Start 不会有反应）".to_string(),
                });
            }

            if pressed && !held {
                // 「按键到了前端」也要留痕迹：只有它和后面的 show/hide 一起，才能把
                // 「没按」「手柄没读到」「按了但没开」这三件事分开。
                fh_core::logutil::write_line("chord fired (Back+Start)");
                crate::overlay::toggle(&app, "chord Back+Start");
            }
            held = pressed;

            if crate::overlay::is_visible() {
                if let Some(window) = app.get_webview_window(crate::overlay::WINDOW_LABEL) {
                    let _ = window.emit("frontend-pad", &pad);
                }
            }
            // 「我还活着」的心跳：日志里全是「什么都没有」时，这一行是唯一能证明
            // 手柄轮询线程还在转的证据（配合启动器那边的 `frontend process up/down`：
            // 进程在 + 心跳在 + 手柄读到了 = 那问题只剩「按键没进来」一种）。
            if heartbeat.elapsed() >= Duration::from_secs(300) {
                heartbeat = std::time::Instant::now();
                let pad = match pad_index {
                    Some(index) => format!("index={index}"),
                    None => "none".to_string(),
                };
                fh_core::logutil::write_line(&format!(
                    "chord alive pad={pad} visible={}",
                    crate::overlay::is_visible()
                ));
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        fh_core::logutil::write_line("chord watch stopped");
    });
}

/// 非 Windows 只保留签名，方便本机 `cargo check`。
#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle) {}
