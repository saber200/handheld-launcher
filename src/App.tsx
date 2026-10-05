import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GamesPage } from "./pages/GamesPage";
import { AppsPage } from "./pages/AppsPage";
import { FilesPage } from "./pages/FilesPage";
import { HomePage } from "./pages/HomePage";
import { DownloadsPage } from "./pages/DownloadsPage";
import { ToolboxPage } from "./pages/ToolboxPage";
import { SettingsPage, closePowerMenu } from "./pages/SettingsPage";
import { BootSplash } from "./components/BootSplash";
import { GamepadKeyboard } from "./components/GamepadKeyboard";
import { closeGamepadKeyboard, gamepadKeyboardOpen, moveDirectionalFocus, steerFocus, useGamepadNav } from "./hooks/useGamepadNav";
import { fileActions } from "./files/actions";
import { useFileJobs } from "./files/useFileJobs";
import { libraryActions } from "./library/actions";
import { NAV, NAV_ROUTES, type TabId } from "./types";
import { BatteryIcon, GamepadIcon, LockIcon, NavIcon, SearchIcon } from "./components/NavIcons";
import { text, useI18n } from "./i18n";
import type { HintPage } from "./i18n/catalog";
import { playSfx, playSwitch, preloadSfx } from "./audio/sfx";
import { formatSize } from "./library/format";

type DriveSpace = { mount: string; label: string; totalBytes: number; freeBytes: number; kind: string };

/**
 * 首页 / 下载：设计稿（K5 / K6）里画了，但要跑起来需要现在还不存在的数据源 ——
 * 最近启动记录、存储容量、续航读数、以及把 OptiScaler / 运行库的安装进度收成一个
 * 任务模型。这一版**只放入口和一句实话**：摆一排假卡片、按下去没反应，比明说"排期中"更糟。
 */
/**
 * 侧栏「文件」入口上的进度环（改造包 §4.2）。
 *
 * 为什么只改侧栏这一处：用户切去游戏库看一眼的时候，恰恰是最需要知道「还在搬」的时刻 ——
 * 而这一版的任务进度只画在文件页里，切走就看不见。侧栏是**每一页都在**的那块地方。
 *
 * 多任务时显示的是总体进度（字节加权；算不出字节就按条数），和任务中心一个口径。
 */
function RailProgress() {
  const jobs = useFileJobs().filter((job) => job.phase === "scan" || job.phase === "run");
  if (jobs.length === 0) return null;
  const totalBytes = jobs.reduce((sum, job) => sum + Math.max(job.totalBytes, 0), 0);
  const doneBytes = jobs.reduce((sum, job) => sum + Math.min(job.bytes, job.totalBytes), 0);
  const totalItems = jobs.reduce((sum, job) => sum + Math.max(job.itemTotal, 1), 0);
  const doneItems = jobs.reduce((sum, job) => sum + job.itemsDone, 0);
  const ratio =
    totalBytes > 0 ? doneBytes / totalBytes : totalItems > 0 ? doneItems / totalItems : 0;
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="nav-progress" role="status" aria-label={`${percent}%`}>
      <svg className="nav-progress-ring" viewBox="0 0 18 18" aria-hidden>
        <circle className="nav-progress-track" cx="9" cy="9" r={radius} />
        <circle
          className="nav-progress-fill"
          cx="9"
          cy="9"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      <span className="nav-progress-text tnum">{percent > 99 ? "✓" : percent}</span>
    </span>
  );
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function App() {
  const { locale } = useI18n();
  const [tab, setTab] = useState<TabId>("games");
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  useGamepadNav({
    enabled: intro === "done",
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
      // Y：规格书 §13.2 的「文件」页那一格是**剪切**。只在真的有选中项时接走，
      // 否则落到全局含义（上下文菜单 —— 属性 / 压缩 / 解压 / 批量重命名都只在里面）。
      if (fileActions().cut?.()) return;
      fileActions().openMenu?.();
    },
    onFaceLeft: () => {
      // X：文件页那一格是**复制**；没选中东西时才回到「进选择模式」——
      // 选择模式是手柄上唯一能多选的路（多选之后靠方向键逐项选中）。
      if (fileActions().copy?.()) return;
      fileActions().toggleSelect?.();
    },
    onStart: () => {
      // Menu / Start：启动器里一直空闲，这里给文件页当「菜单键」用 ——
      // 有选中项时 Y 已经是剪切了，属性 / 压缩那些还得有个入口。
      fileActions().openMenu?.();
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

  /**
   * 侧栏那颗「存储空间」（画板 K5 左下角）。
   *
   * 只读一次：进应用时问一次盘的容量就够（它不会在几秒内变），没必要轮询。
   * 读不到（macOS / 权限）就写「—」，不写 0 —— 0 是「满了」，那是另一个意思。
   */
  const [drives, setDrives] = useState<DriveSpace[]>([]);
  useEffect(() => {
    if (!inTauri()) return;
    void invoke<DriveSpace[]>("system_storage")
      .then(setDrives)
      .catch(() => setDrives([]));
  }, []);
  const primary = drives.find((drive) => drive.kind === "fixed") ?? drives[0] ?? null;
  const usedBytes = primary ? Math.max(0, primary.totalBytes - primary.freeBytes) : 0;
  const storagePercent =
    primary && primary.totalBytes > 0 ? Math.round((usedBytes / primary.totalBytes) * 100) : 0;
  const storageHead = primary
    ? `${formatSize(usedBytes)} / ${formatSize(primary.totalBytes)}`
    : m.shell.storagePending;
  const storageMeta = primary
    ? `${primary.mount} ${primary.label}`.trim()
    : m.shell.storagePending;

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
                  {/* 侧栏唯一为任务层加的东西：文件入口上的进度环（改造包 §4.2）。 */}
                  {item.id === "files" && <RailProgress />}
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
              <strong className="tnum">{storageHead}</strong>
            </div>
            <div className="storage-track" aria-hidden>
              <span className="storage-fill" style={{ width: `${storagePercent}%` }} />
            </div>
            <div className="storage-meta">
              <span>{storageMeta}</span>
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
            {tab === "home" && (
              <HomePage onOpenGames={() => setTab("games")} onOpenApps={() => setTab("apps")} />
            )}
            {tab === "games" && <GamesPage />}
            {tab === "apps" && <AppsPage />}
            {tab === "downloads" && <DownloadsPage onOpenFiles={() => setTab("files")} />}
            {tab === "files" && <FilesPage />}
            {tab === "toolbox" && <ToolboxPage onOpenGames={() => setTab("games")} />}
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
        <SettingsPage active={settingsOpen} onClose={closeSettings} />
      </aside>
    </div>
    {intro !== "done" && <BootSplash playing={intro === "play"} onDone={finishIntro} />}
    </>
  );
}
