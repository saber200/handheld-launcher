//! 手柄：所有手柄都可用 Back+Start 开关浮层，触发者取得导航所有权。
//! 40 ms 轮询；组合键从 Back 按下起隔离，直到动作键和方向全部释放。

use std::time::Duration;

/// 推给界面的状态；隐藏和隔离期间也发送中性输入，让页面清理按键锁存。
#[derive(Default, Debug, Clone, PartialEq, Eq, serde::Serialize)]
struct PadState {
    dx: i8,
    dy: i8,
    a: bool,
    b: bool,
    start: bool,
    visible: bool,
    generation: u64,
    owner: Option<u32>,
    blocked: bool,
}

/// 与系统读取解耦，额外动作也参与释放判定，但不映射为页面操作。
#[derive(Default, Clone, Copy)]
struct PadInput {
    dx: i8,
    dy: i8,
    a: bool,
    b: bool,
    start: bool,
    back: bool,
    other_active: bool,
}

impl PadInput {
    fn neutral(self) -> bool {
        self.dx == 0
            && self.dy == 0
            && !self.a
            && !self.b
            && !self.start
            && !self.back
            && !self.other_active
    }
}

#[derive(Default)]
struct Navigation {
    owner: Option<u32>,
    held: bool,
    isolated: [bool; 4],
    reset: bool,
    display: Option<(bool, u64)>,
}

impl Navigation {
    /// 先检查全部手柄，再开关窗口；同一轮最多触发一次，按住时不能被另一只抢触发。
    fn scan(&mut self, pads: &[Option<PadInput>; 4]) -> Option<u32> {
        let mut chord = None;
        for (index, pad) in pads.iter().enumerate() {
            match pad {
                Some(pad) => {
                    if pad.back {
                        self.isolated[index] = true;
                    } else if pad.neutral() {
                        self.isolated[index] = false;
                    }
                    if pad.back && pad.start && chord.is_none() {
                        chord = Some(index as u32);
                    }
                }
                None => self.isolated[index] = false,
            }
        }
        let fired = chord.filter(|_| !self.held);
        // 半松开后仍属于同一次组合键；全部参与者回到中性（或断连）才允许下次触发。
        self.held = fired.is_some() || (self.held && self.isolated.iter().any(|active| *active));
        let previous = self.owner;
        if let Some(index) = fired {
            self.owner = Some(index);
            self.reset = true;
        } else if !self
            .owner
            .is_some_and(|index| pads[index as usize].is_some())
        {
            self.owner = pads
                .iter()
                .position(Option::is_some)
                .map(|index| index as u32);
        }
        if previous != self.owner {
            self.reset = true;
        }
        fired
    }

    /// 开关后取同一份显示缓存/代数；换代或换手柄必须经过中性帧，不能继承旧按键。
    fn packet(&mut self, pads: &[Option<PadInput>; 4], display: (bool, u64)) -> PadState {
        if self.display != Some(display) {
            self.display = Some(display);
            self.reset = true;
        }
        let input = self.owner.and_then(|index| pads[index as usize]);
        let isolated = self
            .owner
            .is_some_and(|index| self.isolated[index as usize]);
        let blocked = self.reset || isolated || input.is_none();
        if input.is_some_and(PadInput::neutral) {
            // 本帧仍带 blocked，下一帧才允许输入；持续按住时不会提前解锁。
            self.reset = false;
        }
        let mut packet = PadState {
            visible: display.0,
            generation: display.1,
            owner: self.owner,
            blocked,
            ..PadState::default()
        };
        if display.0 && !blocked {
            if let Some(input) = input {
                packet.dx = input.dx;
                packet.dy = input.dy;
                packet.a = input.a;
                packet.b = input.b;
                packet.start = input.start;
            }
        }
        packet
    }
}

/// 只记成功发送的包；失败后可重试，隐藏时变化立即发送，否则约 400 ms 心跳。
#[derive(Default)]
struct Delivery {
    last: Option<(PadState, Duration)>,
}

impl Delivery {
    fn due(&self, packet: &PadState, now: Duration) -> bool {
        packet.visible
            || self.last.as_ref().is_none_or(|(last, sent)| {
                last != packet || now.saturating_sub(*sent) >= Duration::from_millis(400)
            })
    }

    fn sent(&mut self, packet: &PadState, now: Duration) {
        self.last = Some((packet.clone(), now));
    }
}

/// 每次换代/换所有者重新给少量状态变化日志额度，静止或长时间操作不刷屏。
#[derive(Default)]
struct Trace {
    last: Option<PadState>,
    remaining: u8,
}

impl Trace {
    fn record(&mut self, packet: &PadState) -> bool {
        let context_changed = self.last.as_ref().is_none_or(|last| {
            (last.visible, last.generation, last.owner)
                != (packet.visible, packet.generation, packet.owner)
        });
        let changed = self.last.as_ref() != Some(packet);
        if context_changed {
            self.remaining = 8;
        }
        let record = context_changed || (changed && self.remaining > 0);
        if record && !context_changed {
            self.remaining -= 1;
        }
        self.last = Some(packet.clone());
        record
    }
}

#[cfg(windows)]
fn emit_packet(
    app: &tauri::AppHandle,
    packet: &PadState,
    delivery: &mut Delivery,
    now: Duration,
    error_at: &mut Option<std::time::Instant>,
) {
    use tauri::Emitter;

    if !delivery.due(packet, now) {
        return;
    }
    // 直接发往 main，隐藏时仍可接收，不需要每轮查询窗口可见性。
    match app.emit_to(crate::overlay::WINDOW_LABEL, "frontend-pad", packet) {
        Ok(()) => delivery.sent(packet, now),
        Err(err) => {
            if error_at.is_none_or(|last| last.elapsed() >= Duration::from_secs(5)) {
                *error_at = Some(std::time::Instant::now());
                fh_core::logutil::write_line(&format!(
                    "chord frontend-pad emit failed owner={:?} generation={}: {err}",
                    packet.owner, packet.generation
                ));
            }
        }
    }
}

#[cfg(windows)]
pub fn start(app: tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

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

        const DEADZONE: i32 = 16000;
        let mut navigation = Navigation::default();
        let mut delivery = Delivery::default();
        let mut trace = Trace::default();
        let started = Instant::now();
        let mut heartbeat = Instant::now();
        let mut connected = None;
        let mut emit_error_at: Option<Instant> = None;
        while !crate::overlay::quitting() {
            let mut pads = [None; 4];
            let mut connected_mask = 0u8;
            for index in 0..4u32 {
                let mut state = unsafe { std::mem::zeroed::<XINPUT_STATE>() };
                if unsafe { XInputGetState(index, &mut state) } != 0 {
                    continue;
                }
                connected_mask |= 1 << index;
                let buttons = state.Gamepad.wButtons;
                let lx = i32::from(state.Gamepad.sThumbLX);
                let ly = i32::from(state.Gamepad.sThumbLY);
                let dx = if buttons & XINPUT_GAMEPAD_DPAD_LEFT != 0 || lx < -DEADZONE {
                    -1
                } else if buttons & XINPUT_GAMEPAD_DPAD_RIGHT != 0 || lx > DEADZONE {
                    1
                } else {
                    0
                };
                let dy = if buttons & XINPUT_GAMEPAD_DPAD_UP != 0 || ly > DEADZONE {
                    -1
                } else if buttons & XINPUT_GAMEPAD_DPAD_DOWN != 0 || ly < -DEADZONE {
                    1
                } else {
                    0
                };
                let mapped = XINPUT_GAMEPAD_A
                    | XINPUT_GAMEPAD_B
                    | XINPUT_GAMEPAD_BACK
                    | XINPUT_GAMEPAD_START
                    | XINPUT_GAMEPAD_DPAD_LEFT
                    | XINPUT_GAMEPAD_DPAD_RIGHT
                    | XINPUT_GAMEPAD_DPAD_UP
                    | XINPUT_GAMEPAD_DPAD_DOWN;
                pads[index as usize] = Some(PadInput {
                    dx,
                    dy,
                    a: buttons & XINPUT_GAMEPAD_A != 0,
                    b: buttons & XINPUT_GAMEPAD_B != 0,
                    start: buttons & XINPUT_GAMEPAD_START != 0,
                    back: buttons & XINPUT_GAMEPAD_BACK != 0,
                    // X/Y、肩键、摇杆按下、扳机和右摇杆也必须释放，才结束隔离。
                    other_active: buttons & !mapped != 0
                        || state.Gamepad.bLeftTrigger > 30
                        || state.Gamepad.bRightTrigger > 30
                        || i32::from(state.Gamepad.sThumbRX).abs() > DEADZONE
                        || i32::from(state.Gamepad.sThumbRY).abs() > DEADZONE,
                });
            }
            if connected != Some(connected_mask) {
                connected = Some(connected_mask);
                fh_core::logutil::write_line(&format!(
                    "chord pads connected mask={connected_mask:04b}"
                ));
            }
            if let Some(owner) = navigation.scan(&pads) {
                fh_core::logutil::write_line(&format!("chord fired (Back+Start) owner={owner}"));
                // 仅排队到主线程；显示完成后由带代数的状态包更新页面，不阻塞下一轮输入。
                crate::overlay::toggle(&app, "chord Back+Start");
            }
            let packet = navigation.packet(&pads, crate::overlay::input_state());
            // 发送、限流日志和心跳在下方统一处理。
            if trace.record(&packet) {
                fh_core::logutil::write_line(&format!(
                    "chord pad owner={:?} visible={} generation={} dx={} dy={} a={} b={} start={} blocked={}",
                    packet.owner, packet.visible, packet.generation, packet.dx, packet.dy,
                    packet.a, packet.b, packet.start, packet.blocked
                ));
            }
            emit_packet(
                &app,
                &packet,
                &mut delivery,
                started.elapsed(),
                &mut emit_error_at,
            );
            if heartbeat.elapsed() >= Duration::from_secs(300) {
                heartbeat = Instant::now();
                fh_core::logutil::write_line(&format!(
                    "chord alive owner={:?} connected={connected_mask:04b} visible={} generation={}",
                    packet.owner, packet.visible, packet.generation
                ));
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        fh_core::logutil::write_line("chord watch stopped");
    });
}

/// 非 Windows 只保留签名；纯状态测试不依赖 XInput 或窗口。
#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord() -> PadInput {
        PadInput {
            back: true,
            start: true,
            ..PadInput::default()
        }
    }

    fn step(nav: &mut Navigation, pads: &[Option<PadInput>; 4], display: (bool, u64)) -> PadState {
        nav.scan(pads);
        nav.packet(pads, display)
    }

    fn assert_neutral(packet: &PadState) {
        assert_eq!(
            (packet.dx, packet.dy, packet.a, packet.b, packet.start),
            (0, 0, false, false, false)
        );
    }

    #[test]
    fn trigger_takes_ownership_and_other_pads_cannot_navigate() {
        let mut nav = Navigation::default();
        let mut pads = [Some(PadInput::default()), None, Some(chord()), None];
        assert_eq!(nav.scan(&pads), Some(2));
        let packet = nav.packet(&pads, (true, 1));
        assert_eq!(packet.owner, Some(2));
        assert!(packet.blocked);
        assert_neutral(&packet);
        pads[2] = Some(PadInput::default());
        step(&mut nav, &pads, (true, 1));
        pads[0] = Some(PadInput {
            b: true,
            dx: -1,
            ..PadInput::default()
        });
        pads[2] = Some(PadInput {
            a: true,
            dx: 1,
            ..PadInput::default()
        });
        let packet = step(&mut nav, &pads, (true, 1));
        assert_eq!(
            (packet.owner, packet.dx, packet.a, packet.b),
            (Some(2), 1, true, false)
        );
    }

    #[test]
    fn global_hold_allows_only_one_toggle_until_all_chords_release() {
        let mut nav = Navigation::default();
        let mut pads = [Some(chord()), Some(chord()), None, None];
        assert_eq!(nav.scan(&pads), Some(0));
        assert_eq!(nav.scan(&pads), None);
        pads[0] = Some(PadInput::default());
        assert_eq!(nav.scan(&pads), None);
        assert_eq!(nav.owner, Some(0));
        pads[1] = Some(PadInput::default());
        assert_eq!(nav.scan(&pads), None);
        pads[1] = Some(chord());
        assert_eq!(nav.scan(&pads), Some(1));
        assert_eq!(nav.owner, Some(1));
    }

    #[test]
    fn partial_release_cannot_retrigger_until_all_input_is_neutral() {
        for partial in [
            PadInput {
                back: true,
                ..PadInput::default()
            },
            PadInput {
                start: true,
                ..PadInput::default()
            },
            PadInput {
                a: true,
                ..PadInput::default()
            },
            PadInput {
                dx: 1,
                ..PadInput::default()
            },
            PadInput {
                other_active: true,
                ..PadInput::default()
            },
        ] {
            let mut nav = Navigation::default();
            let mut pads = [Some(chord()), None, None, None];
            assert_eq!(nav.scan(&pads), Some(0));
            pads[0] = Some(partial);
            assert_eq!(nav.scan(&pads), None);
            pads[0] = Some(chord());
            assert_eq!(nav.scan(&pads), None);
            pads[0] = Some(PadInput::default());
            assert_eq!(nav.scan(&pads), None);
            pads[0] = Some(chord());
            assert_eq!(nav.scan(&pads), Some(0));
        }
    }

    #[test]
    fn back_isolates_until_start_actions_and_direction_release() {
        let mut nav = Navigation::default();
        let mut pads = [Some(PadInput::default()), None, None, None];
        step(&mut nav, &pads, (true, 1));
        for input in [
            PadInput {
                back: true,
                ..PadInput::default()
            },
            chord(),
            PadInput {
                start: true,
                ..PadInput::default()
            },
            PadInput {
                a: true,
                b: true,
                dx: 1,
                ..PadInput::default()
            },
            PadInput {
                dy: -1,
                ..PadInput::default()
            },
            PadInput {
                other_active: true,
                ..PadInput::default()
            },
        ] {
            pads[0] = Some(input);
            let packet = step(&mut nav, &pads, (true, 1));
            assert!(packet.blocked);
            assert_neutral(&packet);
        }
        pads[0] = Some(PadInput::default());
        assert_neutral(&step(&mut nav, &pads, (true, 1)));
        pads[0] = Some(PadInput {
            start: true,
            ..PadInput::default()
        });
        let packet = step(&mut nav, &pads, (true, 1));
        assert!(!packet.blocked);
        assert!(packet.start);
    }

    #[test]
    fn display_generation_resets_held_input_even_if_visibility_stays_true() {
        let mut nav = Navigation::default();
        let mut pads = [Some(PadInput::default()), None, None, None];
        step(&mut nav, &pads, (true, 1));
        pads[0] = Some(PadInput {
            a: true,
            dx: 1,
            ..PadInput::default()
        });
        assert!(step(&mut nav, &pads, (true, 1)).a);
        for display in [(false, 2), (true, 3), (true, 5)] {
            let packet = step(&mut nav, &pads, display);
            assert_eq!((packet.visible, packet.generation), display);
            assert!(packet.blocked);
            assert_neutral(&packet);
        }
        pads[0] = Some(PadInput::default());
        assert!(step(&mut nav, &pads, (true, 5)).blocked);
        pads[0] = Some(PadInput {
            a: true,
            ..PadInput::default()
        });
        assert!(step(&mut nav, &pads, (true, 5)).a);
        step(&mut nav, &pads, (false, 6));
        pads[0] = Some(PadInput::default());
        step(&mut nav, &pads, (false, 6));
        pads[0] = Some(PadInput {
            a: true,
            ..PadInput::default()
        });
        assert_neutral(&step(&mut nav, &pads, (false, 6)));
    }

    #[test]
    fn hidden_delivery_retries_changes_and_sends_400ms_heartbeat() {
        let mut delivery = Delivery::default();
        let mut packet = PadState::default();
        assert!(delivery.due(&packet, Duration::ZERO));
        // 没有成功确认，下一轮仍应重试。
        assert!(delivery.due(&packet, Duration::from_millis(40)));
        delivery.sent(&packet, Duration::from_millis(40));
        assert!(!delivery.due(&packet, Duration::from_millis(439)));
        assert!(delivery.due(&packet, Duration::from_millis(440)));
        packet.generation = 1;
        assert!(delivery.due(&packet, Duration::from_millis(80)));
        delivery.sent(&packet, Duration::from_millis(80));
        packet.owner = Some(3);
        assert!(delivery.due(&packet, Duration::from_millis(120)));
        delivery.sent(&packet, Duration::from_millis(120));
        packet.blocked = true;
        assert!(delivery.due(&packet, Duration::from_millis(160)));
        packet.visible = true;
        delivery.sent(&packet, Duration::from_millis(160));
        assert!(delivery.due(&packet, Duration::from_millis(200)));
    }

    #[test]
    fn trace_limits_changes_and_renews_budget_on_context_change() {
        let mut trace = Trace::default();
        let mut packet = PadState {
            visible: true,
            owner: Some(1),
            ..PadState::default()
        };
        assert!(trace.record(&packet));
        assert!(!trace.record(&packet));
        for _ in 0..8 {
            packet.a = !packet.a;
            assert!(trace.record(&packet));
        }
        packet.a = !packet.a;
        assert!(!trace.record(&packet));
        packet.owner = Some(2);
        assert!(trace.record(&packet));
        packet.blocked = true;
        assert!(trace.record(&packet));
        packet.generation += 1;
        assert!(trace.record(&packet));
    }

    #[test]
    fn disconnect_falls_back_and_waits_for_neutral_without_first_pad_stealing() {
        let mut nav = Navigation::default();
        let mut pads = [None, None, Some(PadInput::default()), None];
        step(&mut nav, &pads, (true, 1));
        pads[0] = Some(PadInput {
            a: true,
            ..PadInput::default()
        });
        assert_eq!(step(&mut nav, &pads, (true, 1)).owner, Some(2));
        pads[2] = None;
        let packet = step(&mut nav, &pads, (true, 1));
        assert_eq!(packet.owner, Some(0));
        assert!(packet.blocked);
        assert_neutral(&packet);
        assert!(step(&mut nav, &pads, (true, 1)).blocked);
        pads[0] = Some(PadInput::default());
        assert!(step(&mut nav, &pads, (true, 1)).blocked);
        pads[0] = Some(PadInput {
            a: true,
            ..PadInput::default()
        });
        assert!(step(&mut nav, &pads, (true, 1)).a);
        pads[0] = None;
        let packet = step(&mut nav, &pads, (true, 1));
        assert_eq!(packet.owner, None);
        assert!(packet.blocked);
        assert_neutral(&packet);
    }
}
