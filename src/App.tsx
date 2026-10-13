import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EmulatorsPage } from "./pages/EmulatorsPage";
import { GamesPage } from "./pages/GamesPage";
import { AppsPage } from "./pages/AppsPage";
import { FilesPage } from "./pages/FilesPage";
import { HomePage } from "./pages/HomePage";
import { DownloadsPage } from "./pages/DownloadsPage";
import { ToolboxPage } from "./pages/ToolboxPage";
import { SettingsPage, closePowerMenu } from "./pages/SettingsPage";
import { BootSplash } from "./components/BootSplash";
import { GamepadKeyboard } from "./components/GamepadKeyboard";
import {
  closeGamepadKeyboard,
  focusContentLanding,
  gamepadKeyboardOpen,
  moveDirectionalFocus,
  SHELL_NAV_ZONE,
  steerFocus,
  useGamepadNav,
} from "./hooks/useGamepadNav";
import { fileActions } from "./files/actions";
import {
  cancelComposition,
  gamepadKeyActions,
  moveCandidate,
  pressBackspace,
  pressKey,
  pressSpace,
} from "./ime/keyboard";
import { useFileJobs } from "./files/useFileJobs";
import { libraryActions } from "./library/actions";
import { NAV, NAV_ROUTES, type TabId } from "./types";
import {
  BatteryIcon,
  LockIcon,
  NavIcon,
} from "./components/NavIcons";
import { text, useI18n } from "./i18n";
import { playSfx, playSwitch, preloadSfx } from "./audio/sfx";
import { formatSize } from "./library/format";
import { countedDrives, driveTotal, useDriveSpace } from "./system/drives";
import { checkForUpdate } from "./system/updater";

/**
 * 首页 / 下载：设计稿（K5 / K6）里画了，但要跑起来需要现在还不存在的数据源 ——
 * 最近启动记录、存储容量、续航读数、以及把 OptiScaler / 运行库的安装进度收成一个
 * 任务模型。这一版**只放入口和一句实话**：摆一排假卡片、按下去没反应，比明说"排期中"更糟。
 */
/**
 * 「文件」页签上的进度环（改造包 §4.2）。
 *
 * 为什么只改这一处：用户切去游戏库看一眼的时候，恰恰是最需要知道「还在搬」的时刻 ——
 * 而这一版的任务进度只画在文件页里，切走就看不见。页签条是**每一页都在**的那块地方
 * （0.1.71 之前这句话说的是侧栏，2026-10-11 菜单搬去顶栏，落点跟着搬）。
 *
 * 多任务时显示的是总体进度（字节加权；算不出字节就按条数），和任务中心一个口径。
 */
function TabProgress() {
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

/**
 * 逐盘那一格的写法：「356 / 476 GB」——**单位只写一次**。
 *
 * 两个数分开格式化会变成「356.0 GB / 476.0 GB」，一眼扫过去全是重复的 GB；
 * 掌机状态条就那么宽，重复的单位挤掉的是真正要看的数字。两个数不同单位（一个 GB 一个 MB）时
 * 各写各的，绝不硬凑。
 */
function formatUsedOfTotal(used: number, total: number): string {
  const a = formatSize(used);
  const b = formatSize(total);
  const unitA = a.slice(a.lastIndexOf(" ") + 1);
  const unitB = b.slice(b.lastIndexOf(" ") + 1);
  if (!a || !b) return b || a;
  if (unitA && unitA === unitB) {
    return `${a.slice(0, a.length - unitA.length).trim()} / ${b}`;
  }
  return `${a} / ${b}`;
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

  /**
   * 换页（LB/RB、点页签）之后把焦点落进新页的内容区。
   *
   * 为什么不能立刻落：页面是按 tab 重新挂载的，`setTab` 那一刻 DOM 里还是旧页。
   */
  const landNext = useRef(false);

  const landInContent = useCallback(() => {
    let tries = 0;
    const attempt = () => {
      tries += 1;
      // 内容区可能还没渲染完（数据没到），试几次；试不到就作罢 —— 下一次按方向键会走
      // `moveDirectionalFocus` 里「焦点不在池子里」那条兜底，它落的也是同一处落地页。
      if (focusContentLanding() || tries >= 10) return;
      window.setTimeout(attempt, 60);
    };
    window.requestAnimationFrame(attempt);
  }, []);

  useEffect(() => {
    if (!landNext.current) return;
    landNext.current = false;
    landInContent();
  }, [tab, landInContent]);

  /**
   * 开场动画放完（手柄导航正是这一刻启用）→ 把焦点送进内容区。
   *
   * 菜单退出焦点系统之后，启动器**没有「默认停在菜单上」这个状态了**：不主动落一次，
   * 开机后第一次按方向键走的就是「焦点不在池子里」那条兜底。落点与换页同一条规矩
   * （当前那张卡 → 当前选中项 → 内容区第一项），用户看到的第一个焦点环就在正中间那张卡上。
   */
  useEffect(() => {
    if (intro !== "done") return;
    landInContent();
  }, [intro, landInContent]);

  const shiftTab = useCallback((dir: -1 | 1) => {
    if (fileActions().blocksTabs?.()) return;
    // 换页之后焦点也落进新页：不然焦点留在被卸载的旧页上，下一次方向键会从「池子里第一个
    // 可聚焦项」（现在是这一页的第一颗按钮，而不是当前那张卡）重新开始。
    landNext.current = true;
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

  /**
   * Back（手柄 B / 键盘 B）按一下做的事：按优先级关掉最上面那一层。
   *
   * 0.1.71 之前最后还有一步「回菜单」（`focusRail()`）。2026-10-11 菜单改成顶部页签条、
   * 整条退出焦点系统之后，这一步没有落点了 —— 菜单里一个可聚焦元素都没有，焦点也没有
   * 「回菜单」这个状态。所以 B 现在只管关弹层；没弹层可关时什么都不做。
   */
  const backOnce = useCallback(() => {
    if (closePowerMenu()) return;
    // 键盘在组字（拼音还没上屏）时，B 键先**取消组字** —— 这是用户按下 B 的第一意图，
    // 直接把整个键盘关掉会让刚敲的拼音白打。
    if (cancelComposition()) return;
    if (gamepadKeyboardOpen()) {
      closeGamepadKeyboard();
      return;
    }
    if (fileActions().back?.()) return;
    if (libraryActions().closeDialog?.()) return;
    if (libraryActions().openCardMenu?.()) return;
    if (settingsOpen) {
      closeSettings();
      return;
    }
  }, [closeSettings, settingsOpen]);

  useEffect(() => {
    if (intro !== "done") return;
    const onKey = (e: KeyboardEvent) => {
      if (gamepadKeyboardOpen()) {
        if (e.key === "Escape") {
          e.preventDefault();
          // Esc 与手柄 B 同义：先取消组字，没有组字才关键盘
          if (!cancelComposition()) closeGamepadKeyboard();
          return;
        }
        if (e.key === "Backspace" || e.key === "b" || e.key === "B") {
          // 注意：键盘开着时 **b 是「退格」而不是「关闭」**。手柄上用 B 关键盘很自然
          // （它没有别的含义），但物理键盘的用户会想用 b 打字母 —— 让 b 退格更符合直觉，
          // 关闭交给 Esc。
          e.preventDefault();
          pressBackspace();
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          pressSpace();
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          // 有候选时左右键在候选条里走，没候选才在按键之间挪
          if (!moveCandidate(e.key === "ArrowRight" ? 1 : -1)) {
            moveDirectionalFocus(e.key === "ArrowRight" ? 1 : -1, 0);
          }
          e.preventDefault();
          return;
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          moveDirectionalFocus(0, e.key === "ArrowDown" ? 1 : -1);
          e.preventDefault();
          return;
        }
        // 可见字符走和手柄键位**同一条**输入路径，这样中英文两种模式的行为完全一致
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          pressKey(e.key);
          return;
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
        backOnce();
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
  }, [intro, shiftTab, toggleSettings, backOnce]);
  // 依赖里不需要单列 `cancelComposition` / `pressKey` / `pressBackspace` / `moveCandidate`：
  // 它们是 `src/ime/keyboard.ts` 的模块级函数，引用永远不变（不是组件里的闭包）。

  useGamepadNav({
    enabled: intro === "done",
    // 闸二：设置键改成**双击** —— Back+Start 和弦里的 Back 不能顺带把设置抽屉拉开
    // （为什么不用「押后判定」，见 useGamepadNav.ts 的 `viewGesture`）。
    viewGesture: "double",
    onBumperLeft: () => {
      // 键盘开着时 LB/RB 是「翻候选」而不是「换页签」：候选条可能连着十几颗，
      // 摇杆要从按键区挪过去得按好几下，翻页键一步到位（中文输入时的主路径）。
      if (moveCandidate(-1)) return;
      shiftTab(-1);
    },
    onBumperRight: () => {
      if (moveCandidate(1)) return;
      shiftTab(1);
    },
    onView: () => {
      fileActions().dismiss?.();
      libraryActions().closeDialog?.();
      toggleSettings();
    },
    onStart: () => {
      // Menu / Start：启动器里一直空闲，这里给文件页当「菜单键」用 ——
      // 有选中项时 Y 已经是剪切了，属性 / 压缩那些还得有个入口。
      fileActions().openMenu?.();
    },
    onBack: backOnce,
    /*
     * LT / RT：键盘打开时是 **Shift / 回车**（对标 OneXPlayer 的映射），
     * 关着的时候才是文件页换栏 / 书库换分组。
     *
     * LT 是**按住**语义，所以「按下」在 `onTriggerLeft`、「松开」必须另有出处 ——
     * 见下面 `useEffect` 里那段轮询。手柄扳机的松开不像按键那样有边沿事件可用。
     */
    onTriggerLeft: () => {
      if (gamepadKeyboardOpen()) {
        gamepadKeyActions.shiftDown();
        return;
      }
      if (fileActions().switchPane?.(-1)) return;
      libraryActions().cycleGroup?.(-1);
    },
    onTriggerRight: () => {
      if (gamepadKeyboardOpen()) {
        gamepadKeyActions.enter();
        return;
      }
      if (fileActions().switchPane?.(1)) return;
      libraryActions().cycleGroup?.(1);
    },
    // Y = 空格，X = 退格（键盘打开时；关着时仍是「菜单 / 多选」，由下面兜住）
    onFaceTop: () => {
      if (gamepadKeyboardOpen()) {
        gamepadKeyActions.space();
        return;
      }
      if (fileActions().cut?.()) return;
      fileActions().openMenu?.();
    },
    onFaceLeft: () => {
      if (gamepadKeyboardOpen()) {
        gamepadKeyActions.backspace();
        return;
      }
      if (fileActions().copy?.()) return;
      fileActions().toggleSelect?.();
    },
    // L3 = 大写锁定
    onStickPress: () => {
      if (gamepadKeyboardOpen()) gamepadKeyActions.toggleCaps();
    },
  });

  /*
   * LT 的**松开**检测。
   *
   * `useGamepadNav` 的 `onTriggerLeft` 只有「按下」这一个边沿（扳机不像按键那样有成对的
   * 边沿回调可用），而 OneXPlayer 的映射里 LT 是**按住**生效的 Shift —— 不处理松开，
   * 用户按一下 LT 之后 Shift 就永远按着了。
   *
   * 所以在 App 里自己盯一下 `buttons[6]`：键盘打开期间、且上一帧是按下的、这一帧松开了，
   * 就派发 `shiftUp()`。轮询频率 60ms，人感觉不到延迟；键盘关着时这个循环什么都不做。
   */
  useEffect(() => {
    let wasDown = false;
    const timer = window.setInterval(() => {
      if (!gamepadKeyboardOpen()) {
        wasDown = false;
        return;
      }
      const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
      if (!pad) return;
      const down = !!pad.buttons[6]?.pressed;
      if (wasDown && !down) gamepadKeyActions.shiftUp();
      wasDown = down;
    }, 60);
    return () => window.clearInterval(timer);
  }, []);

  const m = text();
  /*
   * OTA：**引导走完之后静默查一次**（用户 2026-10-12：「每次都要重新下载，好麻烦」）。
   *
   * 为什么挂在 App 而不是设置抽屉里：抽屉要用户主动拉开才挂载 —— 那样开机永远不会查，
   * 「开机就知道有没有新版」就成了空话。失败**不打扰用户**（掌机可能压根没联网），
   * 状态留在 idle，抽屉里那一行仍然可以手动点「检查更新」。
   */
  useEffect(() => {
    if (intro !== "done") return;
    void checkForUpdate(true);
  }, [intro]);

  const finishIntro = useCallback(() => setIntro("done"), []);
  const mainLocked = intro !== "done";

  /**
   * 侧栏那颗「存储空间」（画板 K5 左下角）。
   *
   * 数据来自 `system/drives.ts` 的共享快照（首页那一格读的是同一份，不重复问系统），
   * 数字是**所有内置盘之和**（`driveTotal`）—— 一块硬盘拆成 C: + D: 时要画整块盘，
   * 只画 C: 那个数比机器真实存储小一大截。
   * 读不到就写「待接入」，不写 0 —— 0 是「满了」，那是另一个意思。
   * 那句话是**暂时的**：读到之前先这么说，读到之后自然换成真数字（失败会自动补读）。
   */
  const drives = useDriveSpace();
  const storage = driveTotal(drives);
  const storagePercent =
    storage && storage.totalBytes > 0
      ? Math.round((storage.usedBytes / storage.totalBytes) * 100)
      : 0;
  // 总量也用同一套写法（单位只写一次）：整行读起来一致，也省出给逐盘那几格的宽度。
  const storageHead = storage
    ? formatUsedOfTotal(storage.usedBytes, storage.totalBytes)
    : m.shell.storagePending;
  const storageMeta = storage
    ? m.shell.storageVolumes(storage.mounts, storage.label)
    : m.shell.storagePending;
  /*
   * 逐盘容量（用户 2026-10-12：「除了显示总容量，也分盘符显示下容量吧，这样比较一目了然」）。
   *
   * 只列**参与合计的那几块盘**（`countedDrives`，和总量同一个筛选）—— 两处各筛一遍迟早会出现
   * 「合计说 3 块、下面只列 2 块」。用量 = 总量 − 可用（和总量那边一样兜底，不写负数）。
   * 只有一块盘时不画：那时总量就是它自己，再列一遍是废话。
   */
  const storageDrives = countedDrives(drives);
  const showDriveBreakdown = storage !== null && storageDrives.length > 1;

  return (
    <>
    <div className="app-shell" inert={mainLocked || undefined}>
      <div className="ambient" aria-hidden />
      <header className="top-bar">
        <span className="top-clock tnum">{clock}</span>
        <span className="top-date">{dateText}</span>
        {/*
         * 分区页签条 —— 原来的左侧栏菜单（用户 2026-10-11：「直接把 menu 改成顶部的切换…
         * 直接使用 RB 和 LB 来切换，不允许聚焦就可以了」）。
         *
         * **这一条是规矩，别往回调**：里面一个 `data-focusable` 都不许有 —— 只要页签能聚焦，
         * 它就又成了一个焦点域，方向键迟早会从落地页跑回菜单（0.1.71 那版侧栏实测两条路：
         * 焦点掉出池子时落到池子第一项、而池子按 DOM 排序第一项永远是菜单；页面元素没包
         * 焦点域时上下跨域的候选里也含着菜单）。换页只有两条路：手柄 LB/RB、键盘 Q/E。
         * 探针（scripts/probe-ui.mjs）逐页盯着「页签条里 0 个可聚焦元素」。
         */}
        <nav className="nav-items" data-focus-zone={SHELL_NAV_ZONE} aria-label={m.tabs.menu} role="tablist">
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
                tabIndex={-1}
                className={`nav-item${current ? " is-current" : ""}${locked ? " is-locked" : ""}`}
                // 触摸屏点一下要能换页，但**不许把 DOM 焦点留在页签上** —— 焦点一离开内容区，
                // 下一次方向键就得重新找落点（那正是这一版要根治的东西）。
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (locked) return;
                  if (item.id === tab) {
                    // 点当前这一页：把焦点送回内容区（原来「在菜单上按 A」就是这个意思）。
                    landInContent();
                    return;
                  }
                  playSfx("tab");
                  landNext.current = true;
                  setTab(item.id);
                }}
              >
                <NavIcon id={item.id} />
                <span className="nav-label">{label}</span>
                {/* 页签条唯一为任务层加的东西：文件入口上的进度环（改造包 §4.2）。 */}
                {item.id === "files" && <TabProgress />}
                {locked && (
                  <span className="nav-lock" aria-hidden>
                    <LockIcon />
                  </span>
                )}
              </button>
            );
          })}
        </nav>
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
        <div className="tab-panel" role="tabpanel">
          <div key={tab} className="tab-panel-view">
            {tab === "home" && (
              <HomePage onOpenGames={() => setTab("games")} onOpenApps={() => setTab("apps")} />
            )}
            {tab === "games" && <GamesPage />}
            {tab === "apps" && <AppsPage />}
            {tab === "downloads" && <DownloadsPage onOpenFiles={() => setTab("files")} />}
            {tab === "files" && <FilesPage />}
            {tab === "toolbox" && <ToolboxPage />}
            {tab === "emulators" && <EmulatorsPage />}
          </div>
        </div>
        <GamepadKeyboard />
      </div>
      <footer key={tab} className="shell-hint">
        {/*
         * 存储读数（原来是侧栏底部那张卡）：**只读**，用户 2026-10-11 明确去掉那颗
         * 「打开文件」按钮 —— 文件页本来就能从页签进，多一个入口只会多一个焦点。
         * 放在底部状态条左边：这一格每一页都在，切走也看得见还剩多少。
         * 读屏读不到 title，整块给一句 aria-label（盘符那句来自 storageVolumes：
         * 多块盘时必须写明数字是合计）。
         */}
        <span
          className="storage-inline"
          role="status"
          title={storageMeta}
          aria-label={`${m.shell.storageTitle} ${storageHead}，${storageMeta}`}
        >
          <span>{m.shell.storageTitle}</span>
          <span className="storage-track" aria-hidden>
            <span className="storage-fill" style={{ width: `${storagePercent}%` }} />
          </span>
          <strong className="tnum">{storageHead}</strong>
          {showDriveBreakdown && (
            <span className="storage-drives">
              {storageDrives.map((row) => {
                const used = Math.max(0, row.totalBytes - row.freeBytes);
                const title = m.shell.storageDriveTitle(
                  row.mount,
                  row.label,
                  formatSize(used),
                  formatSize(row.totalBytes),
                );
                return (
                  <span key={row.mount} className="storage-drive" title={title}>
                    <b>{row.mount}</b>
                    <span className="tnum">{formatUsedOfTotal(used, row.totalBytes)}</span>
                  </span>
                );
              })}
            </span>
          )}
        </span>
        {/*
         * 这里原来是那条按键提示（A 启动/安装 · B 卡片菜单 · LT/RT 切分组 · LB/RB 切分区 ·
         * ≡ 设置抽屉）。用户 2026-10-12 定案去掉：「要么就只保留 B 键的呼出菜单，把下面的
         * 菜单按钮组去掉（我比较倾向这个）」。理由也站得住：这些提示是**给第一次用的人看的**，
         * 而掌机上的常驻界面每一帧都在为它付面积；手柄怎么按，第一次的引导里已经讲过一遍了。
         */}
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
