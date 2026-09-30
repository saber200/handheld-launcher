// 独立前端的浮层外壳（从 0.1.45 的 src/FrontendShell.tsx 搬来）。
//
// 与旧版的区别：
//  - 可见性只看**自己窗口**的 isVisible()，不再听 `frontend-state`（那是启动器的全局状态，
//    也正是 0.1.45「窗口在屏上、状态却是关的、于是关不掉」的来源）；
//  - 「关闭」= 隐藏窗口（托盘常驻），不是通知启动器；
//  - 手柄状态由本程序 Rust 侧的 XInput 轮询通过 `frontend-pad` 推过来。
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

type FrontendPad = {
  dx: number;
  dy: number;
  a: boolean;
  b: boolean;
  start: boolean;
};

/** 打开那一下的按键不能立刻把浮层关掉（Start 开、B 关）。 */
const CLOSE_GRACE_MS = 1200;

/** 自己窗口的可见性就是唯一真相：400 ms 问一次，够快也不贵。 */
const VISIBLE_POLL_MS = 400;

export function FrontendShell() {
  useI18n();
  const m = text().frontend;
  const [shellActive, setShellActive] = useState(!inTauri());
  const padHeld = useRef({ a: false, b: false, start: false, dx: 0, dy: 0 });
  const padRepeatAt = useRef(0);
  const closeGraceUntil = useRef(0);
  const bMustRelease = useRef(false);

  const close = useCallback(() => {
    if (!inTauri()) return;
    // 关窗 == 隐藏到托盘；真正退出只在托盘菜单里。
    void getCurrentWindow().hide().catch(() => {});
  }, []);

  const closeFromPad = useCallback(() => {
    if (performance.now() < closeGraceUntil.current) return;
    if (bMustRelease.current) return;
    close();
  }, [close]);

  useEffect(() => {
    preloadSfx();
  }, []);

  useEffect(() => {
    if (!inTauri()) {
      setShellActive(true);
      return;
    }
    let cancel = false;
    const syncVisible = () => {
      void getCurrentWindow()
        .isVisible()
        .then((visible) => {
          if (!cancel) setShellActive(visible);
        })
        .catch(() => {});
    };
    syncVisible();
    const timer = window.setInterval(syncVisible, VISIBLE_POLL_MS);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!shellActive) return;
    closeGraceUntil.current = performance.now() + CLOSE_GRACE_MS;
    bMustRelease.current = true;
    const onKey = (e: KeyboardEvent) => {
      if (gamepadKeyboardOpen()) {
        if (e.key === "Escape" || e.key === "b" || e.key === "B") {
          e.preventDefault();
          closeGamepadKeyboard();
        }
        return;
      }
      if (e.key === "Escape" || e.key === "b" || e.key === "B") {
        e.preventDefault();
        closeFromPad();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeFromPad, shellActive]);

  // 浏览器预览用 Gamepad API（Tauri 的 WebView 里它常常给空表，所以那边走 XInput 桥）。
  useGamepadNav({
    enabled: shellActive && !inTauri(),
    onBack: closeFromPad,
    onConfirm: () => {
      confirmFocused();
    },
  });

  useEffect(() => {
    if (!shellActive || !inTauri()) return;
    padHeld.current = { a: true, b: true, start: true, dx: 0, dy: 0 };
    padRepeatAt.current = 0;
    closeGraceUntil.current = performance.now() + CLOSE_GRACE_MS;
    bMustRelease.current = true;
    let primed = false;
    const unlisten = listen<FrontendPad>("frontend-pad", (event) => {
      const pad = event.payload;
      const dx = pad.dx || 0;
      const dy = pad.dy || 0;
      // 打开时按着的键当作已经按下，避免“开的那一下顺手把自己关了”。
      if (!primed) {
        primed = true;
        padHeld.current = { a: true, b: true, start: true, dx, dy };
        if (pad.b) bMustRelease.current = true;
        return;
      }
      if (bMustRelease.current && !pad.b) {
        bMustRelease.current = false;
      }
      const held = padHeld.current;
      const now = performance.now();
      const inGrace = now < closeGraceUntil.current;

      const roseX = dx !== 0 && dx !== held.dx;
      const roseY = dy !== 0 && dy !== held.dy;
      if (roseX || roseY) {
        steerFocus(roseX ? dx : 0, roseX ? 0 : dy);
        padRepeatAt.current = now + 320;
      } else if ((dx !== 0 || dy !== 0) && now >= padRepeatAt.current) {
        steerFocus(dx !== 0 ? dx : 0, dx !== 0 ? 0 : dy);
        padRepeatAt.current = now + 140;
      }

      if (pad.a && !held.a && !inGrace) {
        confirmFocused();
      }
      // B 或 Start 松手后才关（避免开按未松就关掉）。
      if (pad.b && !held.b) closeFromPad();
      if (pad.start && !held.start && !inGrace) closeFromPad();

      padHeld.current = { a: pad.a, b: pad.b, start: pad.start, dx, dy };
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [shellActive, closeFromPad]);

  useEffect(() => {
    if (!shellActive) return;
    // 焦点优先落在面板里的控件上：关闭按钮是鼠标专用（没有 data-focusable）。
    document.querySelector<HTMLElement>(".frontend-panel-body [data-focusable]")?.focus();
  }, [shellActive]);

  return (
    <div className="frontend-shell">
      <header className="frontend-shell-head">
        <h1>{m.title}</h1>
        <button type="button" className="library-tool" onClick={close}>
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
