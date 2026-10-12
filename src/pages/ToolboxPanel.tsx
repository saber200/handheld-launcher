import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { text } from "../i18n";
import { RefreshIcon } from "../components/NavIcons";
import { formatSize } from "../library/format";

type RuntimePackage = {
  id: string;
  name: string;
  detail: string;
  installed: boolean;
};

/** 系统维护卡读到的数（`toolbox_maintenance`，见 Rust 侧 maintain.rs）。 */
type MaintenanceScan = {
  shaderCacheBytes: number;
  shaderCacheDirs: number;
  startupItems: number;
  logBytes: number;
  logDir: string;
  /** 这台机器上能不能读到这些数（macOS = false）。 */
  supported: boolean;
};

/** 清完之后回来的一笔账。 */
type MaintenanceClean = {
  freed: number;
  caches: number;
  logFiles: number;
};

/**
 * 这一页读到的状态，**存在模块作用域**（不是组件 state）。
 *
 * 为什么非得放外面：App.tsx 里每个页签是 `<div key={tab}>`，切走再切回来组件会整个卸载重建，
 * 组件内的 state 每次都从空开始 —— 于是每切一次就把这几条命令重读一遍（其中 `toolbox_maintenance`
 * 要量缓存目录），读到之前卡片上写的是一片灰底字（「正在读取…」「—」「无」，按钮还带 0.5 透明度的
 * disabled 态）。用户原话：「切换到工具箱页面就会自检一遍，屏幕就会灰一次」。
 *
 * 现在的约定：**这一页 = 快照 + 手动自检**。
 * - 本次会话第一次进这一页读一次，之后切来切去都直接画这份快照；
 * - 想刷新按页头右上角那颗「自检」；
 * - 页里自己改动了状态的动作（装运行库 / 立即清理）跑完仍然各自重读一次；
 * - 别处改了同一件事这里不会自己跟 —— 那也是按「自检」。这是刻意的：
 *   切页不等于要求重新体检。
 */
type ToolboxSnapshot = {
  runtimes: RuntimePackage[];
  maintenance: MaintenanceScan | null;
  /** Mod 列表扫出来的行（弹窗开着才有；关掉/切页都留着 —— 卡片状态行要用它写装了哪一版）。 */
};

let snapshot: ToolboxSnapshot | null = null;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 工具箱页（画板 K4）：运行库 + 系统维护两张卡。
 *
 * ⚠️ 2026-10-12：原来这里还有第三张「游戏 Mod / 工具」卡（OptiScaler 状态 + 「查看列表」按钮
 * 列装了哪些游戏）。用户要求**整个去掉**：「反正这个 optiscaler 已经在游戏的弹出按钮组里安装了，
 * 你为啥要留着这个？不如直接去掉得了」—— 装 Mod 的入口只留游戏卡片菜单那一条路，工具箱不再重复。
 * 对应地后端 `toolbox_mod_list` 也删了；「哪些游戏装了」改成游戏卡片上的一颗角标
 * （数据来自扫描时的 `has_mod`，判据是账本 `toolbox::game_has_mod`）。
 *
 * 为什么页头也在这里：右上那颗「自检」就是**把这一页的状态全部重读一遍**，跟下面几张卡
 * 用的是同一批命令，放在同一个组件里才不用绕一圈回调。
 *
 * 这一页的数据是**快照**（模块作用域，见下面 `ToolboxSnapshot`）：切走再切回不重读 ——
 * 只有「自检」和页里那几个动作（装运行库 / 立即清理）会重新读。
 */
export function ToolboxPanel() {
  const m = text().toolbox;
  const panelRef = useRef<HTMLDivElement>(null);
  const [runtimes, setRuntimes] = useState<RuntimePackage[]>(snapshot?.runtimes ?? []);
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");
  // 下面这批的初值全部取自快照：切回这一页时第一帧就是上次读到的内容（不再先灰一下）。
  const [checking, setChecking] = useState(false);
  /** 系统维护那三行 + 清理结果。 */
  const [maintenance, setMaintenance] = useState<MaintenanceScan | null>(snapshot?.maintenance ?? null);
  const [cleaning, setCleaning] = useState(false);
  /** 「查看列表」弹窗；`rows` 关掉弹窗也留着（卡片状态行要用它显示装了哪一版）。 */

  const refreshRuntimes = useCallback(() => {
    if (!inTauri()) {
      setRuntimes([]);
      return;
    }
    void invoke<RuntimePackage[]>("toolbox_runtimes")
      .then(setRuntimes)
      .catch((err) => setNote(m.toolboxFailed(String(err))));
    // m 每次渲染都是新对象（语言包），但这里只用它拼提示行，不进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 系统维护那三行：着色器缓存 / 启动项 / 日志。读一次几毫秒到几百毫秒（量缓存目录）。 */
  const refreshMaintenance = useCallback(() => {
    if (!inTauri()) return;
    void invoke<MaintenanceScan>("toolbox_maintenance")
      .then(setMaintenance)
      .catch(() => setMaintenance(null));
  }, []);

  /** 「立即清理」：删缓存目录 + 自己的日志。结果如实显示（清出多少、删了几个）。 */
  const cleanMaintenance = useCallback(async () => {
    if (!inTauri()) {
      setNote(m.toolboxPreview);
      return;
    }
    setCleaning(true);
    setNote(m.toolboxCleaning);
    try {
      const done = await invoke<MaintenanceClean>("toolbox_maintenance_clean");
      const freed = done.freed > 0 ? formatSize(done.freed) : "";
      setNote(
        done.caches === 0 && done.logFiles === 0
          ? m.toolboxCleanNothing
          : m.toolboxCleanDone(freed || "0 B", done.caches, done.logFiles),
      );
      refreshMaintenance();
    } catch (err) {
      setNote(m.toolboxFailed(String(err)));
    } finally {
      setCleaning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMaintenance]);

  /**
   * 自检 = 把这一页读的状态全部重读一遍（这一页没有「测试」，只有状态）。
   * **只在用户点它时跑**：切页不再重读（见上面 `snapshot` 的说明）。
   */
  const selfCheck = useCallback(() => {
    setNote("");
    refreshRuntimes();
    refreshMaintenance();
    if (!inTauri()) {
      // 浏览器预览下没有后端：卡片自己会写「请在 Windows 掌机上使用」，
      // 这里不再重复一行提示（免得同一句话出现两遍）。
      return;
    }
    // 读取很快，给一个「点到了」的短反馈
    setChecking(true);
    window.setTimeout(() => setChecking(false), 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMaintenance, refreshRuntimes]);

  /**
   * 这次挂载要不要自动读一遍。
   *
   * 刻意在**渲染时**就把答案定下来（而不是等 effect 里再看 snapshot）：下面那个「记回快照」的
   * effect 在挂载时就会把 snapshot 写成非 null，两个 effect 的先后顺序一旦被后人调换，这里会
   * 静默变成「永远不自动读」—— 那种坏法在界面上看不出来（数字只是不再更新）。
   */
  const autoCheck = useRef(snapshot === null);

  useEffect(() => {
    // 只在挂载时跑一次（selfCheck 的依赖都是空依赖 useCallback）
    // 本次会话第一次进这一页才自动读；读过就直接画快照 —— 切页不等于重新体检，
    // 想刷新按页头右上角那颗「自检」。
    if (autoCheck.current) selfCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 每次切到这个页签都是新挂载：给手柄一个起点。
    // 落在主卡那颗按钮上（画板里主卡就是聚焦态），没有才退到第一个可聚焦元素。
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(".k4-primary")?.focus();
    if (!panel?.contains(document.activeElement)) {
      panel?.querySelector<HTMLElement>("[data-focusable]")?.focus();
    }
  }, []);

  /**
   * 状态一有变化就把这份快照记下来（唯一写入口，省得十个 setState 旁边各写一句、
   * 漏掉一个就出现「切回来数字变回灰的」）。它必须排在「自动读」那个 effect **后面**，
   * 否则第一次挂载时 snapshot 会先被写成非 null —— 上面的 autoCheck 就是为这个兜的底。
   */
  useEffect(() => {
    snapshot = {
      runtimes,
      maintenance,
    };
  }, [runtimes, maintenance]);



  const installRuntime = async (id: string) => {
    if (!inTauri()) {
      setNote(m.toolboxPreview);
      return;
    }
    setBusyId(id);
    setNote(m.toolboxInstalling);
    try {
      const message = await invoke<string>("toolbox_install_runtime", { id });
      setNote(message);
      refreshRuntimes();
    } catch (err) {
      setNote(m.toolboxFailed(String(err)));
    } finally {
      setBusyId("");
    }
  };

  const tauri = inTauri();


  /**
   * 系统维护那三行的文案。
   *
   * 为什么用 `supported` 而不是「有没有读到」来判：macOS 上这条命令会**正常返回**
   * （全是 0），拿 0 当数字显示就成了假数据。所以那边走「这台机器上没有」那句老话，
   * 三行不渲染。
   */
  const maintenanceReady = Boolean(maintenance?.supported);
  const cacheRowText = !maintenance
    ? ""
    : maintenance.shaderCacheBytes > 0
      ? m.toolboxCacheRow(bytesText(maintenance.shaderCacheBytes))
      : m.toolboxCacheEmpty;
  const startupRowText = maintenance ? m.toolboxStartupRow(maintenance.startupItems) : "";
  const logRowText = maintenance ? m.toolboxLogRow(bytesText(maintenance.logBytes)) : "";

  return (
    <>
      <div className="k4-head">
        <div className="k4-title">
          <h2>{text().tabs.toolbox}</h2>
          <p className="k4-sub">{m.toolboxSubtitle}</p>
        </div>
        <button type="button" className="k4-selfcheck" data-focusable disabled={checking} onClick={selfCheck}>
          <RefreshIcon />
          {m.toolboxSelfCheck}
        </button>
      </div>

      <div className="k4-body" ref={panelRef}>
        <div className="k4-row">
        </div>

        <div className="k4-pair">
          <section className="k4-card" aria-label={m.runtimesTitle}>
            <h3 className="k4-card-title">{m.runtimesTitle}</h3>
            <p className="k4-card-body">{m.toolboxRuntimesSub}</p>
            {runtimes.length === 0 ? (
              <p className="k4-empty">{tauri ? m.runtimesEmpty : m.toolboxPreview}</p>
            ) : (
              <div className="k4-rows">
                {runtimes.map((pkg) => (
                  <div key={pkg.id} className="k4-row-item">
                    <span className={pkg.installed ? "k4-tick is-on" : "k4-tick"} aria-hidden>
                      {pkg.installed ? "✓" : "○"}
                    </span>
                    <strong>{pkg.name}</strong>
                    <small>{pkg.detail}</small>
                    <button
                      type="button"
                      className="k4-card-action"
                      data-focusable
                      disabled={busyId !== ""}
                      onClick={() => void installRuntime(pkg.id)}
                    >
                      {busyId === pkg.id ? m.toolboxWorking : pkg.installed ? m.toolboxReinstall : m.toolboxInstall}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="k4-actions">
              <button
                type="button"
                className="k4-primary"
                data-focusable
                disabled={checking}
                onClick={selfCheck}
              >
                {m.toolboxRuntimesAction}
              </button>
            </div>
          </section>

          <section className="k4-card" aria-label={m.toolboxMaintenanceTitle}>
            <h3 className="k4-card-title">{m.toolboxMaintenanceTitle}</h3>
            <p className="k4-card-body">{m.toolboxMaintenanceSub}</p>
            {/* 画板上这三行是实数（着色器缓存 3.2 GB / 启动项 4 个 / 日志 12 MB）。
                数字全部来自 `toolbox_maintenance`；这台机器上读不到就不渲染这三行，
                改说「这台机器上没有」—— 0 和「不知道」是两件事。 */}
            {maintenanceReady ? (
              <>
                <div className="k4-rows">
                  <div className="k4-row-item">
                    <span className="k4-tick is-on" aria-hidden>
                      ✓
                    </span>
                    <strong>{cacheRowText}</strong>
                  </div>
                  <div className="k4-row-item">
                    <span className="k4-tick is-on" aria-hidden>
                      ✓
                    </span>
                    <strong>{startupRowText}</strong>
                    {/* 启动项只报数：替用户关掉别人的开机启动是另一件事，这一版不做。 */}
                    <small>{m.toolboxStartupReadonly}</small>
                  </div>
                  <div className="k4-row-item">
                    <span className="k4-tick is-on" aria-hidden>
                      ✓
                    </span>
                    <strong>{logRowText}</strong>
                    {maintenance?.logDir ? <small>{maintenance.logDir}</small> : null}
                  </div>
                </div>
                <div className="k4-actions">
                  <button
                    type="button"
                    className="k4-primary"
                    data-focusable
                    disabled={cleaning}
                    onClick={() => void cleanMaintenance()}
                  >
                    {cleaning ? m.toolboxCleaning : m.toolboxClean}
                  </button>
                </div>
              </>
            ) : (
              <p className="k4-empty">{m.toolboxMaintenancePending}</p>
            )}
          </section>
        </div>

        {note ? <p className="k4-note">{note}</p> : null}
      </div>

    </>
  );
}

/**
 * 字节数写法。和库卡片同一口味（`formatSize`），但 **0 写成「0 B」**：
 * 库卡片那边 0 是「不知道」，这里的 0 是「本来就是空的」，两回事。
 */
function bytesText(bytes: number): string {
  if (bytes <= 0) return "0 B";
  return formatSize(bytes);
}
