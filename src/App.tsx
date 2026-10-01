import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GamesPage } from "./pages/GamesPage";
import { AppsPage } from "./pages/AppsPage";
import { FilesPage } from "./pages/FilesPage";
import { ToolboxPage } from "./pages/ToolboxPage";
import { SettingsPage, closePowerMenu } from "./pages/SettingsPage";
import { BootSplash } from "./components/BootSplash";
import { GamepadKeyboard } from "./components/GamepadKeyboard";
import { closeGamepadKeyboard, gamepadKeyboardOpen, moveDirectionalFocus, steerFocus, useGamepadNav } from "./hooks/useGamepadNav";
import { fileActions } from "./files/actions";
import { libraryActions } from "./library/actions";
import { TABS, type TabId } from "./types";
import { text, useI18n } from "./i18n";
import { playSfx, playSwitch, preloadSfx } from "./audio/sfx";

// 前端（幻想前端）自 0.1.46 起是一个**独立程序**：启动器不再创建浮层窗口、不再注册它的
// 快捷键、也不再和它同步「开/关」状态，所以这里只剩启动器自己的界面逻辑。
// 为什么拆、拆成什么样，见仓库根 FRONTEND.md。

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function App() {
  useI18n();
  const [tab, setTab] = useState<TabId>("games");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 独立前端浮层是否正显示在屏上 —— 由 Rust 侧观察窗口得出（`overlay_watch.rs`）。
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [intro, setIntro] = useState<"wait" | "play" | "done">("wait");

  const shiftTab = useCallback((dir: -1 | 1) => {
    if (fileActions().blocksTabs?.()) return;
    setTab((current) => {
      const index = TABS.findIndex((item) => item.id === current);
      const next = (index + dir + TABS.length) % TABS.length;
      playSfx("tab");
      return TABS[next].id;
    });
  }, []);

  useEffect(() => {
    preloadSfx();
  }, []);

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
    const timer = window.setTimeout(() => setIntro("done"), 2400);
    return () => window.clearTimeout(timer);
  }, [intro]);

  const closeSettings = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest(".drawer-root")) active.blur();
    setSettingsOpen((open) => {
      if (open) playSwitch(false);
      return false;
    });
  }, []);

  const toggleSettings = useCallback(() => {
    setSettingsOpen((open) => {
      if (!open) {
        playSwitch(true);
        return true;
      }
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".drawer-root")) active.blur();
      playSwitch(false);
      return false;
    });
  }, []);

  useEffect(() => {
    if (intro !== "done") return;
    const onKey = (e: KeyboardEvent) => {
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
        if (closePowerMenu()) return;
        if (fileActions().back?.()) return;
        if (libraryActions().closeDialog?.()) return;
        toggleSettings();
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
  }, [intro, shiftTab, toggleSettings]);

  // 闸一：浮层在屏上时**停止消费手柄** —— 前端和我们读的是同一份手柄状态，不设这道闸的话，
  // 在浮层里按 A 会在身后把游戏启动起来、方向键会在身后挪焦点（见 FRONTEND.md §10）。
  // 停的只是手柄：键鼠与 Esc 照旧（键盘事件只进焦点窗口，浮层抢了焦点就不会漏回这里）。
  // 挂载时先问一次，之后收 Rust 侧的状态事件；命令对应 capabilities 的 `allow-overlay-open`。
  useEffect(() => {
    if (!inTauri()) return;
    let cancel = false;
    let stop: (() => void) | undefined;
    void invoke<boolean>("overlay_open")
      .then((open) => {
        if (!cancel) setOverlayOpen(open);
      })
      .catch(() => {});
    void listen<boolean>("overlay-state", (event) => setOverlayOpen(event.payload)).then((un) => {
      if (cancel) un();
      else stop = un;
    });
    return () => {
      cancel = true;
      stop?.();
    };
  }, []);

  useGamepadNav({
    enabled: intro === "done" && !overlayOpen,
    // 闸二：设置键改成**双击** —— Back+Start 和弦里的 Back 不能顺带把设置抽屉拉开
    // （为什么不用「押后判定」，见 useGamepadNav.ts 的 `viewGesture`）。
    viewGesture: "double",
    onBumperLeft: () => {
      shiftTab(-1);
    },
    onBumperRight: () => {
      shiftTab(1);
    },
    onView: () => {
      fileActions().dismiss?.();
      libraryActions().closeDialog?.();
      toggleSettings();
    },
    onFaceTop: () => {
      fileActions().openMenu?.();
    },
    onFaceLeft: () => {
      fileActions().toggleSelect?.();
    },
    onBack: () => {
      if (closePowerMenu()) return;
      if (fileActions().back?.()) return;
      if (libraryActions().closeDialog?.()) return;
      if (libraryActions().openCardMenu?.()) return;
      closeSettings();
    },
    onTriggerLeft: () => {
      libraryActions().cycleGroup?.(-1);
    },
    onTriggerRight: () => {
      libraryActions().cycleGroup?.(1);
    },
  });

  const m = text();
  const finishIntro = useCallback(() => setIntro("done"), []);
  const mainLocked = intro !== "done";

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
              onClick={() => {
                if (item.id === tab) return;
                playSfx("tab");
                setTab(item.id);
              }}
            >
              {m.tabs[item.id]}
            </button>
          ))}
        </nav>
      </header>
      <div className="tab-panel" role="tabpanel">
        <div key={tab} className="tab-panel-view">
          {tab === "games" && <GamesPage />}
          {tab === "apps" && <AppsPage />}
          {tab === "files" && <FilesPage />}
          {tab === "toolbox" && <ToolboxPage />}
        </div>
      </div>
      <GamepadKeyboard />
      <footer key={tab} className="shell-hint">
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
    {intro !== "done" && <BootSplash playing={intro === "play"} onDone={finishIntro} />}
    </>
  );
}
