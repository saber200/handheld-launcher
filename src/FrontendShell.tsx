import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FrontendPage } from "./pages/FrontendPage";
import { closeGamepadKeyboard, gamepadKeyboardOpen, useGamepadNav } from "./hooks/useGamepadNav";
import { text, useI18n } from "./i18n";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function FrontendShell() {
  useI18n();
  const m = text().frontend;

  const close = useCallback(() => {
    if (!inTauri()) {
      window.location.hash = "";
      window.location.reload();
      return;
    }
    void invoke("close_frontend").catch(() => {});
  }, []);

  useEffect(() => {
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
  }, [close]);

  useGamepadNav({
    enabled: true,
    onBack: close,
    onStart: close,
    onConfirm: () => {
      const active = document.activeElement as HTMLElement | null;
      active?.click();
    },
  });

  useEffect(() => {
    document.querySelector<HTMLElement>(".frontend-shell [data-focusable]")?.focus();
  }, []);

  return (
    <div className="frontend-shell focus-trap">
      <header className="frontend-shell-head">
        <h1>{m.title}</h1>
        <button type="button" className="library-tool" data-focusable onClick={close}>
          {m.close}
        </button>
      </header>
      <div className="frontend-shell-body">
        <FrontendPage active />
      </div>
      <footer className="frontend-shell-hint">
        <span>{text().hints.frontend}</span>
        <span>B / Esc {m.close}</span>
      </footer>
    </div>
  );
}
