import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FrontendPage } from "./pages/FrontendPage";
import {
  closeGamepadKeyboard,
  confirmFocused,
  gamepadKeyboardOpen,
  steerFocus,
  useGamepadNav,
} from "./hooks/useGamepadNav";
import { text, useI18n } from "./i18n";
import { preloadSfx } from "./audio/sfx";

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

/** Ignore B close until open-press is released (Start opens; B closes). */
const CLOSE_GRACE_MS = 1200;

export function FrontendShell() {
  useI18n();
  const m = text().frontend;
  // Hidden preload window still runs JS; only handle input while shown.
  const [shellActive, setShellActive] = useState(!inTauri());
  const padHeld = useRef({ a: false, b: false, start: false, dx: 0, dy: 0 });
  const padRepeatAt = useRef(0);
  const closeGraceUntil = useRef(0);
  const bMustRelease = useRef(false);

  const close = useCallback(() => {
    if (!inTauri()) {
      window.location.hash = "";
      window.location.reload();
      return;
    }
    void invoke("close_frontend").catch(() => {});
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
    const timer = window.setInterval(syncVisible, 400);
    const unlisten = listen<boolean>("frontend-state", (event) => {
      if (!cancel) setShellActive(Boolean(event.payload));
    });
    return () => {
      cancel = true;
      window.clearInterval(timer);
      void unlisten.then((stop) => stop());
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
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        closeFromPad();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeFromPad, shellActive]);

  // Browser preview: Gamepad API. Tauri frontend webview often gets empty pads.
  useGamepadNav({
    enabled: shellActive && !inTauri(),
    onBack: closeFromPad,
    onConfirm: () => {
      confirmFocused();
    },
    onStart: closeFromPad,
  });

  // Windows: XInput bridge from Rust (second WebView Gamepad API is unreliable).
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
      // Treat currently held buttons as already down so open-press can't close us.
      if (!primed) {
        primed = true;
        padHeld.current = {
          a: true,
          b: true,
          start: true,
          dx,
          dy,
        };
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
      // B or Start closes after the open-press is released.
      if (pad.b && !held.b) closeFromPad();
      if (pad.start && !held.start && !inGrace) closeFromPad();

      padHeld.current = {
        a: pad.a,
        b: pad.b,
        start: pad.start,
        dx,
        dy,
      };
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [shellActive, closeFromPad]);

  useEffect(() => {
    if (!shellActive) return;
    // Prefer in-panel controls — Close is mouse-only (no data-focusable).
    const preferred = document.querySelector<HTMLElement>(
      ".frontend-shell-body [data-focusable]",
    );
    preferred?.focus();
  }, [shellActive]);

  return (
    <div className="frontend-shell focus-trap open">
      <header className="frontend-shell-head">
        <h1>{m.title}</h1>
        <button type="button" className="library-tool" onClick={close}>
          {m.close}
        </button>
      </header>
      <div className="frontend-shell-body">
        <FrontendPage active={shellActive} />
      </div>
      <footer className="frontend-shell-hint">
        <span>{text().hints.frontend}</span>
        <span>B / Esc {m.close}</span>
      </footer>
    </div>
  );
}
