import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GamesPage } from "./pages/GamesPage";
import { AppsPage } from "./pages/AppsPage";
import { FilesPage } from "./pages/FilesPage";
import { SettingsPage, closePowerMenu } from "./pages/SettingsPage";
import { FrontendPage } from "./pages/FrontendPage";
import { BootSplash } from "./components/BootSplash";
import { GamepadKeyboard } from "./components/GamepadKeyboard";
import { closeGamepadKeyboard, gamepadKeyboardOpen, moveDirectionalFocus, steerFocus, useGamepadNav } from "./hooks/useGamepadNav";
import { fileActions } from "./files/actions";
import { libraryActions } from "./library/actions";
import { TABS, type TabId } from "./types";
import { text, useI18n } from "./i18n";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function App() {
  useI18n();
  const [tab, setTab] = useState<TabId>("games");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [frontendOpen, setFrontendOpen] = useState(false);
  const [intro, setIntro] = useState<"wait" | "play" | "done">("wait");

  const shiftTab = useCallback((dir: -1 | 1) => {
    if (frontendOpen || fileActions().blocksTabs?.()) return;
    setTab((current) => {
      const index = TABS.findIndex((item) => item.id === current);
      const next = (index + dir + TABS.length) % TABS.length;
      return TABS[next].id;
    });
  }, [frontendOpen]);

  useEffect(() => {
    let cancel = false;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    void (async () => {
      if (inTauri()) {
        await getCurrentWindow().setFullscreen(true).catch(() => {});
      }
      await document.fonts.ready.catch(() => undefined);
      if (cancel) return;
      setIntro(reduced ? "done" : "play");
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (intro !== "play") return;
    const timer = window.setTimeout(() => setIntro("done"), 7600);
    return () => window.clearTimeout(timer);
  }, [intro]);

  useEffect(() => {
    if (!inTauri()) return;
    let cancel = false;
    const unlisten = listen<boolean>("frontend-state", (event) => {
      if (!cancel) setFrontendOpen(Boolean(event.payload));
    });
    return () => {
      cancel = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!frontendOpen || !inTauri()) return;
    const steal = () => {
      void invoke("focus_frontend").catch(() => {});
    };
    window.addEventListener("focus", steal);
    return () => window.removeEventListener("focus", steal);
  }, [frontendOpen]);

  const closeSettings = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest(".drawer-root")) active.blur();
    setSettingsOpen(false);
  }, []);

  const toggleSettings = useCallback(() => {
    if (frontendOpen) return;
    setSettingsOpen((open) => {
      if (!open) return true;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".drawer-root")) active.blur();
      return false;
    });
  }, [frontendOpen]);

  const toggleFrontend = useCallback(() => {
    if (fileActions().blocksTabs?.()) return;
    fileActions().dismiss?.();
    libraryActions().closeDialog?.();
    closeSettings();
    if (!inTauri()) {
      setFrontendOpen((open) => !open);
      return;
    }
    void invoke<boolean>("toggle_frontend")
      .then(setFrontendOpen)
      .catch((err) => {
        setFrontendOpen(false);
        console.error("toggle_frontend", err);
      });
  }, [closeSettings]);

  useEffect(() => {
    if (intro !== "done") return;
    const onKey = (e: KeyboardEvent) => {
      if (frontendOpen && inTauri()) {
        if (e.key === "End" || (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "h")) {
          e.preventDefault();
          toggleFrontend();
          return;
        }
        e.preventDefault();
        void invoke("focus_frontend").catch(() => {});
        return;
      }
      if (gamepadKeyboardOpen()) {
        if (e.key === "Escape" || e.key === "b" || e.key === "B") {
          e.preventDefault();
          closeGamepadKeyboard();
          return;
        }
        if (e.key === "ArrowLeft") moveDirectionalFocus(-1, 0);
        if (e.key === "ArrowRight") moveDirectionalFocus(1, 0);
        if (e.key === "ArrowUp") moveDirectionalFocus(0, -1);
        if (e.key === "ArrowDown") moveDirectionalFocus(0, 1);
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (frontendOpen) {
          setFrontendOpen(false);
          return;
        }
        if (closePowerMenu()) return;
        if (fileActions().back?.()) return;
        if (libraryActions().closeDialog?.()) return;
        toggleSettings();
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        toggleFrontend();
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        toggleFrontend();
        return;
      }
      if (frontendOpen) {
        e.preventDefault();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
          const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
          steerFocus(dx, dy);
        }
        return;
      }
      if (e.key === "y" || e.key === "Y") {
        if (fileActions().openMenu?.()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "x" || e.key === "X") {
        if (fileActions().toggleSelect?.()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        if (closePowerMenu()) return;
        if (fileActions().back?.()) return;
        if (libraryActions().closeDialog?.()) return;
        libraryActions().openCardMenu?.();
        return;
      }
      if (e.key === "[") {
        e.preventDefault();
        libraryActions().cycleGroup?.(-1);
        return;
      }
      if (e.key === "]") {
        e.preventDefault();
        libraryActions().cycleGroup?.(1);
        return;
      }
      if (e.key === "q" || e.key === "Q") {
        e.preventDefault();
        shiftTab(-1);
        return;
      }
      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        shiftTab(1);
        return;
      }
      if (e.key === "ArrowLeft") moveDirectionalFocus(-1, 0);
      if (e.key === "ArrowRight") moveDirectionalFocus(1, 0);
      if (e.key === "ArrowUp") moveDirectionalFocus(0, -1);
      if (e.key === "ArrowDown") moveDirectionalFocus(0, 1);
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [intro, shiftTab, toggleSettings, toggleFrontend, frontendOpen]);

  useGamepadNav({
    enabled: intro === "done" && !(frontendOpen && inTauri()),
    onBumperLeft: () => {
      if (!frontendOpen) shiftTab(-1);
    },
    onBumperRight: () => {
      if (!frontendOpen) shiftTab(1);
    },
    onView: () => {
      if (frontendOpen) return;
      fileActions().dismiss?.();
      libraryActions().closeDialog?.();
      toggleSettings();
    },
    onStart: () => {
      if (frontendOpen && !inTauri()) {
        setFrontendOpen(false);
        return;
      }
      toggleFrontend();
    },
    onFaceTop: () => {
      if (frontendOpen) return;
      fileActions().openMenu?.();
    },
    onFaceLeft: () => {
      if (frontendOpen) return;
      fileActions().toggleSelect?.();
    },
    onBack: () => {
      if (frontendOpen && !inTauri()) {
        setFrontendOpen(false);
        return;
      }
      if (closePowerMenu()) return;
      if (fileActions().back?.()) return;
      if (libraryActions().closeDialog?.()) return;
      if (libraryActions().openCardMenu?.()) return;
      closeSettings();
    },
    onTriggerLeft: () => {
      if (!frontendOpen) libraryActions().cycleGroup?.(-1);
    },
    onTriggerRight: () => {
      if (!frontendOpen) libraryActions().cycleGroup?.(1);
    },
  });

  const m = text();
  const finishIntro = useCallback(() => setIntro("done"), []);
  const previewFrontend = frontendOpen && !inTauri();
  // Only lock the main shell when a real frontend window is up.
  // Keep the settings drawer interactive so Quit still works if state drifts.
  const mainLocked = intro !== "done" || (frontendOpen && inTauri());

  return (
    <>
    <div className="app-shell" inert={mainLocked || undefined}>
      <div className="ambient" aria-hidden />
      <header className="tab-bar">
        <nav className="tab-list" role="tablist" aria-label={m.tabs.menu}>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className="tab"
              onClick={() => setTab(item.id)}
            >
              {m.tabs[item.id]}
            </button>
          ))}
        </nav>
      </header>
      <div className="tab-panel" role="tabpanel">
        {tab === "games" && <GamesPage />}
        {tab === "apps" && <AppsPage />}
        {tab === "files" && <FilesPage />}
      </div>
      <GamepadKeyboard />
      <footer className="shell-hint">
        {tab === "files" ? (
          <>
            <span>{m.hints.filesNav}</span>
            <span>{m.hints.filesMulti}</span>
            <span>{m.hints.filesOpen}</span>
            <span>{m.hints.filesBack}</span>
            <span>{m.hints.filesCopy}</span>
            <span>{m.hints.filesTabs}</span>
          </>
        ) : (
          <>
            <span>{m.hints.tabs}</span>
            <span>{m.hints.keys}</span>
            <span>{m.hints.settings}</span>
            <span>{m.hints.frontend}</span>
            <span>{m.hints.groups}</span>
            <span>{m.hints.focusTools}</span>
            <span>{m.hints.cardMenu}</span>
            <span>{m.hints.confirm}</span>
          </>
        )}
      </footer>
    </div>
    <div
      className={`drawer-root focus-trap ${settingsOpen ? "open" : ""}`}
      aria-hidden={!settingsOpen}
      inert={intro !== "done" || undefined}
    >
      <button
        type="button"
        className="drawer-scrim"
        aria-label={m.settings.close}
        tabIndex={-1}
        onClick={closeSettings}
      />
      <aside className="drawer" role="dialog" aria-label={m.settings.title}>
        <h1>{m.settings.title}</h1>
        <SettingsPage active={settingsOpen} />
      </aside>
    </div>
    {previewFrontend && (
      <div className="drawer-root focus-trap open frontend-preview">
        <button
          type="button"
          className="drawer-scrim"
          aria-label={m.frontend.close}
          tabIndex={-1}
          onClick={() => setFrontendOpen(false)}
        />
        <aside className="drawer is-end" role="dialog" aria-label={m.frontend.title}>
          <h1>{m.frontend.title}</h1>
          <FrontendPage active />
          <div className="library-tools" style={{ marginTop: 16 }}>
            <button type="button" className="library-tool" data-focusable onClick={() => setFrontendOpen(false)}>
              {m.frontend.close}
            </button>
          </div>
        </aside>
      </div>
    )}
    {intro !== "done" && <BootSplash playing={intro === "play"} onDone={finishIntro} />}
    </>
  );
}
