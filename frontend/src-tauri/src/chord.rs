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
        while !crate::overlay::quitting() {
            let mut pressed = false;
            let mut pad = PadState::default();
            for index in 0..4u32 {
                let mut state = unsafe { std::mem::zeroed::<XINPUT_STATE>() };
                if unsafe { XInputGetState(index, &mut state) } != 0 {
                    continue;
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
                pad = PadState {
                    dx,
                    dy,
                    a: buttons & XINPUT_GAMEPAD_A != 0,
                    b: buttons & XINPUT_GAMEPAD_B != 0,
                    start: buttons & XINPUT_GAMEPAD_START != 0,
                };
                break;
            }

            if pressed && !held {
                crate::overlay::toggle(&app, "chord Back+Start");
            }
            held = pressed;

            if crate::overlay::is_visible() {
                if let Some(window) = app.get_webview_window(crate::overlay::WINDOW_LABEL) {
                    let _ = window.emit("frontend-pad", &pad);
                }
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        fh_core::logutil::write_line("chord watch stopped");
    });
}

/// 非 Windows 只保留签名，方便本机 `cargo check`。
#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle) {}

