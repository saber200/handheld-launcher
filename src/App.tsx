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
import { NAV, NAV_ROUTES, type TabId } from "./types";
import { BatteryIcon, GamepadIcon, LockIcon, NavIcon, SearchIcon } from "./components/NavIcons";
import { text, useI18n } from "./i18n";
import type { HintPage } from "./i18n/catalog";
import { playSfx, playSwitch, preloadSfx } from "./audio/sfx";

// 前端（幻想前端）自 0.1.46 起是一个**独立程序**：启动器不再创建浮层窗口、不再注册它的
// 快捷键、也不再和它同步「开/关」状态，所以这里只剩启动器自己的界面逻辑。
// 为什么拆、拆成什么样，见仓库根 FRONTEND.md。

/**
 * 首页 / 下载：设计稿（K5 / K6）里画了，但要跑起来需要现在还不存在的数据源 ——
 * 最近启动记录、存储容量、续航读数、以及把 OptiScaler / 运行库 / 前端的安装进度收成一个
 * 任务模型。这一版**只放入口和一句实话**：摆一排假卡片、按下去没反应，比明说"排期中"更糟。
 */
function ScheduledPage({ kind }: { kind: "home" | "downloads" }) {
  const m = text().scheduled;
  return (
    <main className="page scheduled-page">
      <div className="placeholder-panel scheduled-panel">
        <h2>{kind === "home" ? m.homeTitle : m.downloadsTitle}</h2>
        <p>{kind === "home" ? m.homeBody : m.downloadsBody}</p>
      </div>
    </main>
  );
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function App() {
  const { locale } = useI18n();
  const [tab, setTab] = useState<TabId>("games");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 独立前端浮层是否正显示在屏上 —— 由 Rust 侧观察窗口得出（`overlay_watch.rs`）。
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [intro, setIntro] = useState<"wait" | "play" | "done">("wait");

  // 顶栏左侧的时钟 / 日期（设计稿 K1）。30 秒刷一次足够，不用每秒重渲染整个壳。
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // 顶栏右侧电量：WebView2 不一定提供 Battery Status API。**拿不到就不显示这一格** ——
  // 顶栏宁可少一格，也不摆一个假电量（改造包没有要求，但"显示真数据"是项目一贯做法）。
  const [battery, setBattery] = useState<number | null>(null);
  useEffect(() => {
    type BatteryLike = { level: number; addEventListener: (type: "levelchange", fn: () => void) => void };
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    if (typeof nav.getBattery !== "function") return;
    let alive = true;
    let manager: BatteryLike | null = null;
    const sync = () => {
      if (alive && manager) setBattery(Math.round(manager.level * 100));
    };
    void nav
      .getBattery()
      .then((next) => {
        if (!alive) return;
        manager = next;
        sync();
        next.addEventListener("levelchange", sync);
      })
      .catch(() => {
        /* 没有电池 / 接口被禁用：那一格就不出现 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const clockLocale = locale === "en" ? "en-US" : "zh-CN";
  const clock = now.toLocaleTimeString(clockLocale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const dateText = now.toLocaleDateString(clockLocale, { weekday: "short", month: "numeric", day: "numeric" });

  const shiftTab = useCallback((dir: -1 | 1) => {
    if (fileActions().blocksTabs?.()) return;
    setTab((current) => {
      // 只在可进入的分区里循环：商店 / 社区是锁定项，LB/RB 必须跳过（改造包 §1.1）。
      const index = NAV_ROUTES.indexOf(current);
      const next = (index + dir + NAV_ROUTES.length) % NAV_ROUTES.length;
      playSfx("tab");
      return NAV_ROUTES[next];
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
      if (fileActions().switchPane?.(-1)) return;
      libraryActions().cycleGroup?.(-1);
    },
    onTriggerRight: () => {
      if (fileActions().switchPane?.(1)) return;
      libraryActions().cycleGroup?.(1);
    },
  });

  const m = text();
  // 商店 / 社区是锁定项，永远进不来；这里仍显式排掉，好让类型收窄到 HintPage。
  const hintPage: HintPage = tab === "store" || tab === "community" ? "home" : tab;
  const finishIntro = useCallback(() => setIntro("done"), []);
  const mainLocked = intro !== "done";

  return (
    <>
    <div className="app-shell" inert={mainLocked || undefined}>
      <div className="ambient" aria-hidden />
      <header className="top-bar">
        <span className="top-clock tnum">{clock}</span>
        <span className="top-date">{dateText}</span>
        <h1 className="top-title">{m.tabs[tab]}</h1>
        <div className="top-bar-right">
          {/* 电量只有真读到才显示：WebView2 没有电池接口时这一格整块不出现 */}
          {battery !== null && (
            <span className="top-chip tnum">
              <BatteryIcon level={battery / 100} />
              {battery}%
            </span>
          )}
        </div>
      </header>
      <div className="shell-body">
        <nav className="nav-rail" data-focus-zone="shell-rail" aria-label={m.tabs.menu}>
          <div className="rail-brand">
            <span className="rail-brand-mark" aria-hidden>
              <GamepadIcon />
            </span>
            <span className="rail-brand-text">
              <strong>{m.productName}</strong>
              <small>{m.shell.brandTagline}</small>
            </span>
          </div>
          {/* 全局搜索还没接真能力（要跨游戏库/软件库/文件聚合），先只做视觉占位：
              aria-hidden 且不 focusable —— 不做按了没反应的假按钮。 */}
          <div className="rail-search" aria-hidden>
            <SearchIcon />
            <span>{m.shell.searchPlaceholder}</span>
          </div>
          <div className="rail-items" role="tablist" aria-label={m.tabs.menu}>
            {NAV.map((item) => {
              const label = m.tabs[item.id];
              const current = tab === item.id;
              const locked = item.locked === true;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={current}
                  // 锁定项（商店 / 社区）：读屏播报「不可用」，但**不进 [data-focusable]**、
                  // 不进 Tab 顺序、点了不弹任何提示 —— 禁用入口不该有任何可交互反馈。
                  aria-label={locked ? m.shell.lockedAria(label) : undefined}
                  data-focusable={locked ? undefined : true}
                  tabIndex={locked ? -1 : undefined}
                  className={`nav-item${current ? " is-current" : ""}${locked ? " is-locked" : ""}`}
                  onClick={() => {
                    if (locked || item.id === tab) return;
                    playSfx("tab");
                    setTab(item.id);
                  }}
                >
                  <NavIcon id={item.id} />
                  <span className="nav-label">{label}</span>
                  {locked && (
                    <span className="nav-lock" aria-hidden>
                      <LockIcon />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="storage-card">
            <div className="storage-head">
              <span>{m.shell.storageTitle}</span>
              <strong className="tnum">—</strong>
            </div>
            <div className="storage-track" aria-hidden>
              <span className="storage-fill" style={{ width: "0%" }} />
            </div>
            <div className="storage-meta">
              <span>{m.shell.storagePending}</span>
            </div>
            <button
              type="button"
              className="storage-action"
              data-focusable
              onClick={() => {
                playSfx("tab");
                setTab("files");
              }}
            >
              <GamepadIcon />
              {m.shell.storageAction}
            </button>
          </div>
        </nav>
        <div className="tab-panel" role="tabpanel">
          <div key={tab} className="tab-panel-view">
            {tab === "home" && <ScheduledPage kind="home" />}
            {tab === "games" && <GamesPage />}
            {tab === "apps" && <AppsPage />}
            {tab === "downloads" && <ScheduledPage kind="downloads" />}
            {tab === "files" && <FilesPage />}
            {tab === "toolbox" && <ToolboxPage />}
          </div>
        </div>
        <GamepadKeyboard />
      </div>
      <footer key={tab} className="shell-hint">
        {m.hintPairs[hintPage].map(([key, label]) => (
          <span key={key} className="hint-pair">
            <span className={key.length === 1 ? "hint-key is-round" : "hint-key"}>{key}</span>
            {label}
          </span>
        ))}
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
