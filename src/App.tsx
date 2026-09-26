import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GamesPage } from "./pages/GamesPage";
import { AppsPage } from "./pages/AppsPage";
import { FilesPage } from "./pages/FilesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { moveDirectionalFocus, useGamepadNav } from "./hooks/useGamepadNav";
import { fileActions } from "./files/actions";
import { libraryActions } from "./library/actions";
import { TABS, type TabId } from "./types";

export default function App() {
  const [tab, setTab] = useState<TabId>("games");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const shiftTab = useCallback((dir: -1 | 1) => {
    if (fileActions().blocksTabs?.()) return;
    setTab((current) => {
      const index = TABS.findIndex((item) => item.id === current);
      const next = (index + dir + TABS.length) % TABS.length;
      return TABS[next].id;
    });
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    void win.setFullscreen(true).catch(() => {});
  }, []);

  const closeSettings = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest(".drawer-root")) active.blur();
    setSettingsOpen(false);
  }, []);

  const toggleSettings = useCallback(() => {
    setSettingsOpen((open) => {
      if (!open) return true;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".drawer-root")) active.blur();
      return false;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (fileActions().back?.()) return;
        if (libraryActions().closeDialog?.()) return;
        toggleSettings();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
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
  }, [shiftTab, toggleSettings]);

  useGamepadNav({
    onBumperLeft: () => shiftTab(-1),
    onBumperRight: () => shiftTab(1),
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
      if (fileActions().back?.()) return;
      if (libraryActions().closeDialog?.()) return;
      if (libraryActions().openCardMenu?.()) return;
      closeSettings();
    },
    onTriggerLeft: () => libraryActions().cycleGroup?.(-1),
    onTriggerRight: () => libraryActions().cycleGroup?.(1),
  });

  return (
    <div className="app-shell">
      <div className="ambient" aria-hidden />
      <header className="tab-bar">
        <nav className="tab-list" role="tablist" aria-label="主菜单">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className="tab"
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="tab-panel" role="tabpanel">
        {tab === "games" && <GamesPage />}
        {tab === "apps" && <AppsPage />}
        {tab === "files" && <FilesPage />}
      </div>
      <div
        className={`drawer-root focus-trap ${settingsOpen ? "open" : ""}`}
        aria-hidden={!settingsOpen}
      >
        <button
          type="button"
          className="drawer-scrim"
          aria-label="关闭设置"
          tabIndex={-1}
          onClick={closeSettings}
        />
        <aside className="drawer" role="dialog" aria-label="设置">
          <h1>设置</h1>
          <SettingsPage active={settingsOpen} />
        </aside>
      </div>
      <footer className="shell-hint">
        {tab === "files" ? (
          <>
            <span>方向键选择</span>
            <span>X 多选</span>
            <span>A 用系统打开</span>
            <span>B 返回</span>
            <span>Y 复制 / 移动</span>
            <span>LB / RB 切换</span>
          </>
        ) : (
          <>
            <span>LB / RB 切换</span>
            <span>键盘 Q / E</span>
            <span>Back / Share / Esc 设置</span>
            <span>LT / RT 切换分组</span>
            <span>方向键移到新建 / 添加</span>
            <span>B 卡片操作</span>
            <span>A / Enter 启动或确认</span>
          </>
        )}
      </footer>
    </div>
  );
}
