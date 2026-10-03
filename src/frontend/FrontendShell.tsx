// 本进程 Rust 管理显示状态；监听常驻，不再等窗口可见查询成功才接手柄。
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  closeGamepadKeyboard,
  confirmFocused,
  gamepadKeyboardOpen,
  steerFocus,
  useGamepadNav,
} from "../hooks/useGamepadNav";
import { text, useI18n } from "../i18n";
import { preloadSfx } from "../audio/sfx";
import { FrontendPanel } from "./FrontendPanel";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type DisplayState = { visible: boolean; generation: number };
type FrontendPad = DisplayState & {
  dx: number;
  dy: number;
  a: boolean;
  b: boolean;
  start: boolean;
  owner: number | null;
  blocked: boolean;
};
const neutral = () => ({ a: false, b: false, start: false, dx: 0, dy: 0 });
const CLOSE_GRACE_MS = 1200;

function trace(stage: string, generation: number) {
  if (inTauri()) void invoke("overlay_input_trace", { stage, generation }).catch(() => {});
}

export function FrontendShell() {
  useI18n();
  const m = text().frontend;
  const [shellActive, setShellActive] = useState(!inTauri());
  const display = useRef<DisplayState>({ visible: !inTauri(), generation: -1 });
  const owner = useRef<number | null>(null);
  const padHeld = useRef(neutral());
  const padReady = useRef(false);
  const padRepeatAt = useRef(0);
  const closeGraceUntil = useRef(0);
  const closeButton = useRef<HTMLButtonElement>(null);

  const applyDisplay = useCallback((state: DisplayState) => {
    // 查询响应可能晚于事件：旧代数不能把刚关闭的页面重新激活。
    if (state.generation < display.current.generation) return false;
    if (state.generation !== display.current.generation || state.visible !== display.current.visible) {
      padReady.current = false;
      padHeld.current = neutral();
      padRepeatAt.current = 0;
      closeGraceUntil.current = performance.now() + CLOSE_GRACE_MS;
      display.current = state;
      setShellActive(state.visible);
    }
    return true;
  }, []);

  const close = useCallback(() => {
    if (!inTauri()) return;
    // 统一走 Rust：作废旧重试、更新输入状态，再隐藏；不直接调用 window.hide。
    void invoke("overlay_hide").catch(() => trace("close-failed", Math.max(0, display.current.generation)));
  }, []);

  const closeFromPad = useCallback(() => {
    if (performance.now() >= closeGraceUntil.current) close();
  }, [close]);

  useEffect(() => { preloadSfx(); }, []);

  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    let timer: number | undefined;
    let lastError = -Infinity;
    // 串行兜底查询，事件注册前或失败后也能恢复，不堆积在途请求。
    const sync = async () => {
      try {
        const state = await invoke<DisplayState>("overlay_state");
        if (!cancelled) applyDisplay(state);
      } catch {
        if (!cancelled && performance.now() - lastError >= 5000) {
          lastError = performance.now();
          trace("state-failed", Math.max(0, display.current.generation));
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(sync, 400);
      }
    };
    void sync();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [applyDisplay]);

  useEffect(() => {
    if (!shellActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "b" && e.key !== "B") return;
      e.preventDefault();
      if (gamepadKeyboardOpen()) closeGamepadKeyboard();
      else close(); // 键盘不受手柄未释放或呼出宽限影响。
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, shellActive]);

  useGamepadNav({
    enabled: shellActive && !inTauri(),
    onBack: closeFromPad,
    onConfirm: () => { confirmFocused(); },
  });

  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    let retry: number | undefined;
    let receivedGeneration = -1;
    let actionGeneration = -1;
    let lastError = -Infinity;
    const connect = async () => {
      // 注册重试/页面重挂载后不能把持续按住当成新的按下。
      padReady.current = false;
      padHeld.current = neutral();
      padRepeatAt.current = 0;
      try {
        const unlisten = await listen<FrontendPad>("frontend-pad", ({ payload: pad }) => {
          if (cancelled || !applyDisplay(pad)) return;
          if (receivedGeneration !== pad.generation) {
            receivedGeneration = pad.generation;
            trace("received", pad.generation);
          }
          if (owner.current !== pad.owner) {
            owner.current = pad.owner;
            padReady.current = false;
            padHeld.current = neutral();
            padRepeatAt.current = 0;
          }
          if (!pad.visible || pad.blocked) {
            padReady.current = false;
            padHeld.current = neutral();
            padRepeatAt.current = 0;
            return;
          }
          if (!padReady.current) {
            // blocked 包里的零值是隔离产物，不算释放；只接受未隔离的中性包。
            padReady.current = !pad.a && !pad.b && !pad.start && pad.dx === 0 && pad.dy === 0;
            return;
          }
          const { dx, dy } = pad;
          const held = padHeld.current;
          const now = performance.now();
          const inGrace = now < closeGraceUntil.current;
          const roseX = dx !== 0 && dx !== held.dx;
          const roseY = dy !== 0 && dy !== held.dy;
          let acted = false;
          if (roseX || roseY) {
            steerFocus(roseX ? dx : 0, roseX ? 0 : dy);
            padRepeatAt.current = now + 320;
            acted = true;
          } else if ((dx !== 0 || dy !== 0) && now >= padRepeatAt.current) {
            steerFocus(dx !== 0 ? dx : 0, dx !== 0 ? 0 : dy);
            padRepeatAt.current = now + 140;
            acted = true;
          }
          if (pad.a && !held.a && !inGrace) {
            confirmFocused();
            acted = true;
          }
          // Start 只参与 Rust 组合键，单键不关闭，避免先按 Start 再按 Back 时关后又开。
          if (pad.b && !held.b && !inGrace) {
            if (gamepadKeyboardOpen()) closeGamepadKeyboard();
            else closeFromPad();
            acted = true;
          }
          if (acted && actionGeneration !== pad.generation) {
            actionGeneration = pad.generation;
            trace("action", pad.generation);
          }
          padHeld.current = { a: pad.a, b: pad.b, start: pad.start, dx, dy };
        });
        if (cancelled) unlisten();
        else {
          stop = unlisten;
          trace("listening", Math.max(0, display.current.generation));
        }
      } catch {
        if (cancelled) return;
        if (performance.now() - lastError >= 5000) {
          lastError = performance.now();
          trace("listen-failed", Math.max(0, display.current.generation));
        }
        retry = window.setTimeout(connect, 1000);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      stop?.();
    };
  }, [applyDisplay, closeFromPad]);

  useEffect(() => {
    if (!shellActive) return;
    // 驱动未就绪且没有运行游戏时，也必须有手柄可聚焦的关闭入口。
    const first = document.querySelector<HTMLElement>(
      '.frontend-panel-body [data-focusable]:not(:disabled):not([aria-disabled="true"])',
    );
    (first ?? closeButton.current)?.focus();
  }, [shellActive]);

  return (
    <div className="frontend-shell">
      <header className="frontend-shell-head">
        <h1>{m.title}</h1>
        <button ref={closeButton} type="button" className="library-tool" data-focusable onClick={close}>
          {m.close}
        </button>
      </header>
      <div className="frontend-shell-body">
        <FrontendPanel active={shellActive} />
      </div>
      <footer className="frontend-shell-hint">
        <span>{text().hints.frontend}</span>
        <span>B / Esc {m.close}</span>
      </footer>
    </div>
  );
}