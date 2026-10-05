import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { text } from "../i18n";
import { NavIcon, RefreshIcon } from "../components/NavIcons";
import { formatSize } from "../library/format";

type RuntimePackage = {
  id: string;
  name: string;
  detail: string;
  installed: boolean;
};

/** WinRing0 驱动的状态（`toolbox_tdp_driver_status`，形状在共享内核里）。 */
type TdpDriverStatus = {
  ready: boolean;
  elevated: boolean;
  installed: boolean;
  message: string;
};

/** `tdp_status` 里这一页要用的字段（后端名）。 */
type TdpInfo = {
  backend: string;
  supported: boolean;
  message: string;
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

/** 装了 OptiScaler 的一个游戏（`toolbox_mod_list`）。 */
type InstalledMod = {
  game: string;
  dir: string;
  version: string;
  hook: string;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 工具箱页（画板 K4）：TDP 驱动主卡 + 游戏 Mod 工具 / 运行库 / 系统维护。
 *
 * 为什么页头也在这里：右上那颗「自检」就是**把这一页的状态全部重读一遍**，跟下面几张卡
 * 用的是同一批命令，放在同一个组件里才不用绕一圈回调。
 *
 * 卡里写的都是真字段：驱动状态来自 `toolbox_tdp_driver_status`（ready / installed /
 * elevated），后端名来自 `tdp_status`。**画板上的「版本 1.3.0」与「系统维护」那三项不画** ——
 * 前者没有数据源（驱动版本没暴露出来），后者要新的系统信息 / 清理命令；照项目一贯做法
 * 如实写清、不摆假数字。
 */
export function ToolboxPanel({ onOpenGames }: { onOpenGames?: () => void }) {
  const m = text().toolbox;
  const panelRef = useRef<HTMLDivElement>(null);
  const [runtimes, setRuntimes] = useState<RuntimePackage[]>([]);
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");
  const [driver, setDriver] = useState<TdpDriverStatus | null>(null);
  const [tdp, setTdp] = useState<TdpInfo | null>(null);
  const [driverBusy, setDriverBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  /** 主卡「版本」那一格：驱动文件里真实的版本号，拿不到是空串（界面写「—」）。 */
  const [driverVersion, setDriverVersion] = useState("");
  /** 系统维护那三行 + 清理结果。 */
  const [maintenance, setMaintenance] = useState<MaintenanceScan | null>(null);
  const [cleaning, setCleaning] = useState(false);
  /** 「查看列表」弹窗；`rows` 关掉弹窗也留着（卡片状态行要用它显示装了哪一版）。 */
  const [modList, setModList] = useState<{ open: boolean; busy: boolean; rows: InstalledMod[]; error: string } | null>(
    null,
  );

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

  const refreshDriver = useCallback(() => {
    if (!inTauri()) return;
    void invoke<TdpDriverStatus>("toolbox_tdp_driver_status")
      .then(setDriver)
      .catch(() => setDriver(null));
    void invoke<TdpInfo>("tdp_status")
      .then(setTdp)
      .catch(() => setTdp(null));
    // 版本单独一条命令：拿不到就空串，卡片写「—」（不猜一个版本号）。
    void invoke<string>("toolbox_driver_version")
      .then((value) => setDriverVersion(value || ""))
      .catch(() => setDriverVersion(""));
  }, []);

  /** 系统维护那三行：着色器缓存 / 启动项 / 日志。读一次几毫秒到几百毫秒（量缓存目录）。 */
  const refreshMaintenance = useCallback(() => {
    if (!inTauri()) return;
    void invoke<MaintenanceScan>("toolbox_maintenance")
      .then(setMaintenance)
      .catch(() => setMaintenance(null));
  }, []);

  /**
   * 「查看列表」：**现扫一遍库里的游戏目录**（账本写在每个游戏目录里，没有集中的索引）。
   * 慢几秒，所以只在用户点的时候跑；扫描期间弹窗里写「正在扫」。
   */
  const openModList = useCallback(() => {
    if (!inTauri()) {
      setModList({ open: true, busy: false, rows: [], error: m.toolboxPreview });
      return;
    }
    setModList((prev) => ({ open: true, busy: true, rows: prev?.rows ?? [], error: "" }));
    void invoke<InstalledMod[]>("toolbox_mod_list")
      .then((rows) => setModList({ open: true, busy: false, rows, error: "" }))
      .catch((err) =>
        setModList({ open: true, busy: false, rows: [], error: m.toolboxFailed(String(err)) }),
      );
    // m 是语言包对象，每次渲染都新；这里只借它拼提示行。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** 自检 = 把这一页读的状态全部重读一遍（这一页没有「测试」，只有状态）。 */
  const selfCheck = useCallback(() => {
    setNote("");
    refreshRuntimes();
    refreshDriver();
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
  }, [refreshDriver, refreshMaintenance, refreshRuntimes]);

  useEffect(() => {
    // 只在挂载时跑一次（selfCheck 的依赖都是空依赖 useCallback）
    selfCheck();
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

  /** 装 / 重装 WinRing0：命令在启动器侧（要 UAC）。 */
  const installDriver = async () => {
    if (!inTauri()) {
      setNote(m.toolboxPreview);
      return;
    }
    setDriverBusy(true);
    setNote(m.tdpDriverInstalling);
    try {
      const next = await invoke<TdpDriverStatus>("toolbox_install_tdp_driver");
      setDriver(next);
      setNote(next.message);
      refreshDriver();
    } catch (err) {
      setNote(m.toolboxFailed(String(err)));
    } finally {
      setDriverBusy(false);
    }
  };

  const tauri = inTauri();

  /** 「查看列表」这颗按钮：扫描中写「处理中」，其余时候就是画板上那三个字。 */
  const modListActionLabel = modList?.busy ? m.toolboxWorking : m.toolboxModListAction;
  /**
   * Mod 卡的状态行（画板上写的是「OptiScaler 2.4」）：只有**所有**装了 Mod 的游戏版本一致
   * 时才写出版本号 —— 版本不一致时写哪一个都是在骗人，那种情况让用户点开列表看。
   */
  const modVersions = new Set((modList?.rows ?? []).map((row) => row.version).filter(Boolean));
  const modStatus =
    modList && !modList.busy && !modList.error && modList.rows.length > 0
      ? m.toolboxModInstalled(
          modList.rows.length,
          modVersions.size === 1 ? [...modVersions][0] : "",
        )
      : "";

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

  // 驱动那三格：拿不到就如实写「不可用」，不假装已装。
  const stateText = !driver
    ? tauri
      ? m.toolboxWorking
      : m.toolboxBackendNone
    : driver.ready
      ? m.toolboxStateReady
      : driver.installed
        ? m.toolboxStateInstalled
        : m.toolboxStateMissing;
  const stateClass = !driver ? "is-off" : driver.ready || driver.installed ? "is-on" : "is-warn";
  const backendText = tdp && tdp.backend && tdp.backend !== "none" ? tdp.backend : m.toolboxBackendNone;

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
          {/* 主卡：TDP 驱动（画板 616×196，accent 2dp 描边） */}
          <section className="k4-main" aria-label={m.toolboxDriverTitle}>
            <div className="k4-card">
              <p className="k4-label">{m.toolboxDriverLabel}</p>
              <h3 className="k4-card-title">{m.toolboxDriverTitle}</h3>
              <p className="k4-card-body">{m.tdpDriverBody}</p>
              <dl className="k4-stats">
                <div className="k4-stat">
                  <dt>{m.toolboxStateLabel}</dt>
                  <dd className={stateClass}>{stateText}</dd>
                </div>
                <div className="k4-stat">
                  <dt>{m.toolboxVersionLabel}</dt>
                  {/* 驱动文件里真实的版本号；读不到写「—」——
                      画板上那一格写着「1.3.0」，但没装驱动时不该有数字。 */}
                  <dd className={driverVersion ? "tnum" : "is-off"}>{driverVersion || "—"}</dd>
                </div>
                <div className="k4-stat">
                  <dt>{m.toolboxBackendLabel}</dt>
                  <dd className={backendText === m.toolboxBackendNone ? "is-off" : undefined}>{backendText}</dd>
                </div>
                <div className="k4-stat">
                  <dt>{m.toolboxPermLabel}</dt>
                  <dd className={driver?.elevated ? "is-warn" : "is-off"}>
                    {driver?.elevated ? m.toolboxAdmin : m.toolboxStandardUser}
                  </dd>
                </div>
              </dl>
              <div className="k4-actions">
                <button
                  type="button"
                  className="k4-primary"
                  data-focusable
                  disabled={driverBusy}
                  onClick={() => void installDriver()}
                >
                  {driverBusy
                    ? m.tdpDriverInstalling
                    : driver?.installed
                      ? m.tdpDriverReinstall
                      : m.tdpDriverInstall}
                </button>
                <p className="k4-note">{m.toolboxDriverNote}</p>
              </div>
            </div>
          </section>

          <div className="k4-side">
            <section className="k4-card" aria-label={m.toolboxModTitle}>
              <div className="k4-card-head">
                <span className="k4-card-icon" aria-hidden>
                  <NavIcon id="toolbox" />
                </span>
                <div className="k4-card-text">
                  <h3 className="k4-card-title">{m.toolboxModTitle}</h3>
                  <p className="k4-card-body">{modStatus || m.toolboxModBody}</p>
                </div>
                {/* 画板这颗按钮是「查看列表」：列出哪些游戏装了 Mod。
                    以前这里是「去游戏库」（那时没有列列表的命令）；现在有 `toolbox_mod_list`
                    了，按钮就按画板做真事 —— 去游戏库那条路仍然在（游戏卡片的菜单里）。 */}
                <button type="button" className="k4-card-action" data-focusable onClick={openModList}>
                  {modListActionLabel}
                </button>
              </div>
            </section>
          </div>
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

      {modList?.open && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setModList({ ...modList, open: false })}
          />
          <div
            className="group-dialog-panel group-create-panel"
            role="dialog"
            aria-label={m.toolboxModListTitle}
          >
            <h2>{m.toolboxModListTitle}</h2>
            {/* 扫描要几秒（要用库里的游戏列表逐个查账本），所以先把话说清楚。 */}
            <p className="group-empty">{m.toolboxModListBody}</p>
            {modList.busy ? (
              <p className="group-empty">{m.toolboxModListLoading}</p>
            ) : modList.error ? (
              <p className="group-empty">{modList.error}</p>
            ) : modList.rows.length === 0 ? (
              <p className="group-empty">{m.toolboxModListEmpty}</p>
            ) : (
              <div className="k4-rows">
                {modList.rows.map((row) => (
                  <div key={row.dir} className="k4-row-item">
                    <span className="k4-tick is-on" aria-hidden>
                      ✓
                    </span>
                    <strong>
                      {m.toolboxModListEntry(row.game, row.version || m.toolboxModListLegacy)}
                    </strong>
                    <small>
                      {row.dir}
                      {row.hook ? ` · ${row.hook}` : ""}
                    </small>
                  </div>
                ))}
              </div>
            )}
            <div className="library-tools">
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  setModList({ ...modList, open: false });
                  onOpenGames?.();
                }}
              >
                {m.toolboxModAction}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => setModList({ ...modList, open: false })}
              >
                {text().close}
              </button>
            </div>
          </div>
        </div>
      )}
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
