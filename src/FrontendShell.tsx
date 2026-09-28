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

export function FrontendShell() {
  useI18n();
  const m = text().frontend;
  // Hidden preload window still runs JS; only handle input while shown.
  const [shellActive, setShellActive] = useState(!inTauri());
  const padHeld = useRef({ a: false, b: false, start: false, dx: 0, dy: 0 });
  const padRepeatAt = useRef(0);

  const close = useCallback(() => {
    if (!inTauri()) {
      window.location.hash = "";
      window.location.reload();
      return;
    }
    void invoke("close_frontend").catch(() => {});
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
    const onKey = (e: KeyboardEvent) => {
      if (gamepadKeyboardOpen()) {
        if (e.key === "Escape" || e.key === "b" || e.key === "B") {
          e.preventDefault();
          closeGamepadKeyboard();
        }
        return;
      }
      if (e.key === "Escape" || e.key === "b" || e.key === "B" || e.key === "End") {
        e.preventDefault();
        close();
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, shellActive]);

  // Browser preview: Gamepad API. Tauri frontend webview often gets empty pads.
  useGamepadNav({
    enabled: shellActive && !inTauri(),
    onBack: close,
    onStart: close,
    onConfirm: () => {
      const active = document.activeElement as HTMLElement | null;
      active?.click();
    },
  });

  // Windows: XInput bridge from Rust (second WebView Gamepad API is unreliable).
  useEffect(() => {
    if (!shellActive || !inTauri()) return;
    padHeld.current = { a: false, b: false, start: false, dx: 0, dy: 0 };
    padRepeatAt.current = 0;
    let primed = false;
    const unlisten = listen<FrontendPad>("frontend-pad", (event) => {
      const pad = event.payload;
      const dx = pad.dx || 0;
      const dy = pad.dy || 0;
      // First sample after open: sync held state so the Start that opened us doesn't close.
      if (!primed) {
        primed = true;
        padHeld.current = { a: pad.a, b: pad.b, start: pad.start, dx, dy };
        return;
      }
      const held = padHeld.current;
      const now = performance.now();

      const roseX = dx !== 0 && dx !== held.dx;
      const roseY = dy !== 0 && dy !== held.dy;
      if (roseX || roseY) {
        steerFocus(roseX ? dx : 0, roseX ? 0 : dy);
        padRepeatAt.current = now + 320;
      } else if ((dx !== 0 || dy !== 0) && now >= padRepeatAt.current) {
        steerFocus(dx !== 0 ? dx : 0, dx !== 0 ? 0 : dy);
        padRepeatAt.current = now + 140;
      }

      if (pad.a && !held.a) {
        confirmFocused();
        const active = document.activeElement as HTMLElement | null;
        active?.click();
      }
      if (pad.b && !held.b) {
        if (!closeGamepadKeyboard()) close();
      }
      if (pad.start && !held.start) close();

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
  }, [shellActive, close]);

  useEffect(() => {
    if (!shellActive) return;
    document.querySelector<HTMLElement>(".frontend-shell [data-focusable]")?.focus();
  }, [shellActive]);

  return (
    <div className="frontend-shell focus-trap">
      <header className="frontend-shell-head">
        <h1>{m.title}</h1>
        <button type="button" className="library-tool" data-focusable onClick={close}>
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
