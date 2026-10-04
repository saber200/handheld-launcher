import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { text } from "../i18n";
import { NavIcon, OverlayIcon, RefreshIcon } from "../components/NavIcons";

type RuntimePackage = {
  id: string;
  name: string;
  detail: string;
  installed: boolean;
};

/** 工具箱里的前端卡片读到的安装状态（由前端自己写的记录得出）。 */
type FrontendStatus = {
  installed: boolean;
  version: string;
  exe: string;
  payload: boolean;
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

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 工具箱页（画板 K4）：TDP 驱动主卡 + 前端 / 游戏 Mod 工具 / 运行库 / 系统维护。
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
  const m = text().frontend;
  const panelRef = useRef<HTMLDivElement>(null);
  const [runtimes, setRuntimes] = useState<RuntimePackage[]>([]);
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");
  const [frontend, setFrontend] = useState<FrontendStatus | null>(null);
  const [frontendBusy, setFrontendBusy] = useState(false);
  const [driver, setDriver] = useState<TdpDriverStatus | null>(null);
  const [tdp, setTdp] = useState<TdpInfo | null>(null);
  const [driverBusy, setDriverBusy] = useState(false);
  const [checking, setChecking] = useState(false);

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

  const refreshFrontend = useCallback(() => {
    if (!inTauri()) return;
    void invoke<FrontendStatus>("frontend_status")
      .then(setFrontend)
      .catch(() => setFrontend(null));
  }, []);

  const refreshDriver = useCallback(() => {
    if (!inTauri()) return;
    void invoke<TdpDriverStatus>("toolbox_tdp_driver_status")
      .then(setDriver)
      .catch(() => setDriver(null));
    void invoke<TdpInfo>("tdp_status")
      .then(setTdp)
      .catch(() => setTdp(null));
  }, []);

  /** 自检 = 把这一页读的状态全部重读一遍（这一页没有「测试」，只有状态）。 */
  const selfCheck = useCallback(() => {
    setNote("");
    refreshRuntimes();
    refreshFrontend();
    refreshDriver();
    if (!inTauri()) {
      // 浏览器预览下没有后端：卡片自己会写「请在 Windows 掌机上使用」，
      // 这里不再重复一行提示（免得同一句话出现两遍）。
      return;
    }
    // 读取很快，给一个「点到了」的短反馈
    setChecking(true);
    window.setTimeout(() => setChecking(false), 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshDriver, refreshFrontend, refreshRuntimes]);

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

  /** 安装/更新前端：只跑随包的安装包（会先请正在运行的前端自己退出）。 */
  const installFrontend = async () => {
    if (!inTauri()) {
      setNote(m.toolboxPreview);
      return;
    }
    setFrontendBusy(true);
    setNote(m.toolboxInstalling);
    try {
      setNote(await invoke<string>("frontend_install"));
      refreshFrontend();
    } catch (err) {
      setNote(m.toolboxFailed(String(err)));
    } finally {
      setFrontendBusy(false);
    }
  };

  /** 装 / 重装 WinRing0：命令在启动器侧（要 UAC），独立前端那边只读。 */
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
  const frontendStatus = !frontend
    ? ""
    : frontend.installed
      ? m.frontendStatusInstalled(frontend.version || "?")
      : frontend.payload
        ? m.frontendStatusMissing
        : m.frontendNoPayload;

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
            <section className="k4-card" aria-label={m.frontendTitle}>
              <div className="k4-card-head">
                <span className="k4-card-icon" aria-hidden>
                  <OverlayIcon />
                </span>
                <div className="k4-card-text">
                  <h3 className="k4-card-title">{m.frontendTitle}</h3>
                  <p className="k4-card-body">{frontendStatus || m.frontendBody}</p>
                </div>
                <button
                  type="button"
                  className="k4-card-action"
                  data-focusable
                  disabled={frontendBusy || frontend?.payload === false}
                  onClick={() => void installFrontend()}
                >
                  {frontendBusy ? m.toolboxWorking : m.frontendAction}
                </button>
              </div>
            </section>

            <section className="k4-card" aria-label={m.toolboxModTitle}>
              <div className="k4-card-head">
                <span className="k4-card-icon" aria-hidden>
                  <NavIcon id="toolbox" />
                </span>
                <div className="k4-card-text">
                  <h3 className="k4-card-title">{m.toolboxModTitle}</h3>
                  <p className="k4-card-body">{m.toolboxModBody}</p>
                </div>
                {/* 画板这颗按钮是「查看列表」（列出哪些游戏装了 Mod）—— 那要新命令（扫库里每个
                    游戏的安装目录 + 安装账本）。这里给的是同一件事现在就能走的走法：去游戏库，
                    在那边的卡片菜单里对单个游戏装 / 卸。 */}
                <button type="button" className="k4-card-action" data-focusable onClick={() => onOpenGames?.()}>
                  {m.toolboxModAction}
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
            <p className="k4-empty">{m.toolboxMaintenancePending}</p>
          </section>
        </div>

        {note ? <p className="k4-note">{note}</p> : null}
      </div>
    </>
  );
}
