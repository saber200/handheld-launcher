/*
 * 模拟器页（新页签「模拟器」）：一张卡一个平台，A 键装、装完就能启动。
 *
 * 数据是**快照 + 自检**（跟工具箱 K4 一个路子，理由也一样）：`App.tsx` 里每个页签是
 * `<div key={tab}>`，切走再切回来组件整个卸载重建 —— 状态放组件里，每次切回来都要把
 * 这一页重读一遍（其中「量体积」要递归数上万个文件），读到之前卡片上是一片灰底字。
 * 所以：本次会话第一次进这一页读一次，之后切来切去直接画快照；想刷新按页头那颗「自检」。
 *
 * 页面上一共三种卡：
 *   - 能自动装的（PCSX2 / shadPS4 / MAME / RetroArch）：装 / 重装 / 启动 / 打开目录 / 卸载；
 *   - 装不了的（RPCS3 / Switch）：只有一颗「打开官网」，卡上写清楚为什么不能自动装，
 *     **不拿第三方镜像站顶上** —— 那是让用户的掌机去装来路不明的 exe；
 *   - 正在装的那一张：进度条 + 取消。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderPicker } from "../files/FolderPicker";
import { RefreshIcon } from "../components/NavIcons";
import { text } from "../i18n";
import { formatSize } from "../library/format";
import { RomsPanel } from "../emulators/RomsPanel";
import { taskCtx } from "../files/tasks/env";
import {
  PREVIEW_EMULATORS,
  PREVIEW_EMULATOR_ROOT,
  PREVIEW_EMULATOR_SIZES,
} from "../data/previewEmulators";
import {
  beginEmulatorInstall,
  endEmulatorInstall,
  useEmulatorProgress,
  type EmulatorPhase,
} from "../emulators/useEmulatorProgress";

/** Rust 侧 `emulator.rs::EmulatorStatus` 的形状（预览假数据也用这个类型）。 */
export type EmulatorStatus = {
  id: string;
  name: string;
  badge: string;
  emulator: string;
  vendor: string;
  desc: string;
  note: string;
  /** 非空 = 这一项不能自动装，里面是原因。 */
  manualReason: string;
  manualUrl: string;
  installed: boolean;
  version: string;
  dir: string;
  /** ROM 根（`<非系统盘>:\Emulation\ROMs`）下这个平台的子目录名。 */
  romDir: string;
  exe: string;
  bytes: number;
  /** macOS / 浏览器预览里为 false。 */
  supported: boolean;
};

/** Rust 侧 `EmulatorRoot` 的形状。 */
export type EmulatorRoot = {
  root: string;
  defaultRoot: string;
  custom: boolean;
  supported: boolean;
};

type Snapshot = {
  rows: EmulatorStatus[];
  root: EmulatorRoot | null;
};

let snapshot: Snapshot | null = null;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 把两张表合起来：装没装、多大、版本号（`bytes` 只有量过才有）。 */
function merge(rows: EmulatorStatus[], sizes: Map<string, number>): EmulatorStatus[] {
  return rows.map((row) => {
    const measured = sizes.get(row.id);
    return measured === undefined ? row : { ...row, bytes: measured };
  });
}

export function EmulatorsPage() {
  const t = text().emulators;
  const [rows, setRows] = useState<EmulatorStatus[]>(snapshot?.rows ?? []);
  const [root, setRoot] = useState<EmulatorRoot | null>(snapshot?.root ?? null);
  /** 这一页读完了没有：读之前不写「未安装」这种结论（那会是一句错话）。 */
  const [loaded, setLoaded] = useState(Boolean(snapshot));
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [measuring, setMeasuring] = useState(false);
  /** `id` 非空 = 正在等二次确认的那张卡（卸载会连存档一起删，必须问一次）。 */
  const [confirming, setConfirming] = useState("");
  /**
   * 「游戏列表」面板开着的时候，这里是那张卡。
   *
   * ROM 根（`<非系统盘>:\Emulation\ROMs`）跟「导入 ROM」那个任务**读的是同一处**
   * （`taskCtx().dirs.roms`，底下再拼平台子目录 `row.romDir`）—— 两处各算一遍迟早会出现
   * 「导入到 A、列表看 B」。
   */
  const [romsFor, setRomsFor] = useState<EmulatorStatus | null>(null);
  const [romRoot, setRomRoot] = useState("");
  const [picking, setPicking] = useState(false);
  const { id: installingId, progress } = useEmulatorProgress();

  /**
   * `sizes` 传 true 才去量体积（递归数文件，RetroArch 上万个文件要几秒）。
   * 「自检」与「装完之后」会量一次，切入这一页不量 —— 账本里存着上次量到的数。
   */
  const load = useCallback(async (withSizes: boolean) => {
    if (!inTauri()) {
      // 浏览器预览：真数据全在 Rust 侧（Windows 专属），这里画一份假数据，
      // 好让这一页的排版在本机也能被看见（见 data/previewEmulators.ts）。
      const list = withSizes
        ? merge(PREVIEW_EMULATORS, new Map(PREVIEW_EMULATOR_SIZES))
        : PREVIEW_EMULATORS;
      setRows(list);
      setRoot({
        root: PREVIEW_EMULATOR_ROOT,
        defaultRoot: PREVIEW_EMULATOR_ROOT,
        custom: false,
        supported: false,
      });
      setLoaded(true);
      return;
    }
    try {
      const [list, rootInfo] = await Promise.all([
        invoke<EmulatorStatus[]>("emulator_list"),
        invoke<EmulatorRoot>("emulator_root"),
      ]);
      let next = list;
      if (withSizes) {
        const sizes = await invoke<[string, number][]>("emulator_sizes");
        next = merge(list, new Map(sizes));
      }
      setRows(next);
      setRoot(rootInfo);
      setLoaded(true);
      snapshot = { rows: next, root: rootInfo };
    } catch (err) {
      setNote(t.failed(String(err)));
      setLoaded(true);
    }
    // t 是语言包对象，每次渲染都新；这里只借它拼提示行，不进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (snapshot) return;
    void load(false);
  }, [load]);

  /**
   * 第一帧就把焦点放在页头那颗「自检」上：这一页从侧栏切进来时焦点还挂在侧栏上，
   * 方向键会先在侧栏里走。跟工具箱页一致。
   */
  const headRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest(".emu-page")) return;
    headRef.current?.focus();
  }, []);

  const selfCheck = useCallback(async () => {
    setNote("");
    setLoaded(false);
    await load(true);
  }, [load]);

  const install = useCallback(
    async (row: EmulatorStatus) => {
      if (!inTauri()) {
        setNote(t.unsupported);
        return;
      }
      setBusy(row.id);
      setNote("");
      setConfirming("");
      beginEmulatorInstall(row.id);
      try {
        const done = await invoke<string>("emulator_install", { id: row.id });
        setNote(done || t.installedNote(row.emulator));
      } catch (err) {
        setNote(t.failed(String(err)));
      } finally {
        endEmulatorInstall();
        setBusy("");
        // 装完之后重读这一页（并量一次新装的体积）。
        void load(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  const uninstall = useCallback(
    async (row: EmulatorStatus) => {
      setBusy(row.id);
      setConfirming("");
      setNote("");
      try {
        const done = await invoke<string>("emulator_uninstall", { id: row.id });
        setNote(done || t.removedNote(row.emulator));
      } catch (err) {
        setNote(t.failed(String(err)));
      } finally {
        setBusy("");
        void load(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  /** 启动就是普通启动（复用游戏库那条命令：它有进程检测与前台窗口处理）。 */
  const launch = useCallback(
    async (row: EmulatorStatus) => {
      if (!inTauri()) {
        setNote(t.unsupported);
        return;
      }
      // 先说一句「正在启动」：模拟器是几百 MB 的程序，第一次打开要初始化配置，
      // 冷启动几秒很正常 —— 界面上什么都不说的话，用户会以为这颗按钮点坏了。
      setNote(t.launchedNote(row.emulator));
      try {
        await invoke("launch_item", {
          id: `emulator:${row.id}`,
          launchPath: row.exe,
          installPath: row.dir,
          switchIfRunning: true,
        });
      } catch (err) {
        setNote(t.failed(String(err)));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const openRoms = useCallback(async (row: EmulatorStatus) => {
    try {
      const ctx = await taskCtx();
      setRomRoot(ctx.dirs.roms);
    } catch {
      setRomRoot("");
    }
    setRomsFor(row);
  }, []);

  const openFolder = useCallback(
    async (row: EmulatorStatus) => {
      if (!inTauri()) return;
      try {
        await invoke("file_open", { path: row.dir });
      } catch (err) {
        setNote(t.failed(String(err)));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const openSite = useCallback(
    async (row: EmulatorStatus) => {
      if (!inTauri()) return;
      try {
        await invoke("emulator_open_site", { id: row.id });
      } catch (err) {
        setNote(t.failed(String(err)));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const applyRoot = useCallback(async (next: string) => {
    try {
      const info = await invoke<EmulatorRoot>("emulator_set_root", { root: next });
      setRoot(info);
      snapshot = { rows: snapshot?.rows ?? [], root: info };
    } catch (err) {
      setNote(t.failed(String(err)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const measure = useCallback(async () => {
    if (!inTauri()) return;
    setMeasuring(true);
    if (!inTauri()) {
      setRows((current) => merge(current, new Map(PREVIEW_EMULATOR_SIZES)));
      return;
    }
    try {
      const sizes = await invoke<[string, number][]>("emulator_sizes");
      setRows((current) => {
        const next = merge(current, new Map(sizes));
        snapshot = { rows: next, root: snapshot?.root ?? null };
        return next;
      });
    } catch (err) {
      setNote(t.failed(String(err)));
    } finally {
      setMeasuring(false);
    }
  }, []);

  /** 进度条上那几个阶段的中文 / 英文（阶段名由 Rust 侧给）。 */
  const phaseLabel = (phase: EmulatorPhase | string): string => {
    switch (phase) {
      case "resolve":
        return t.phaseResolve;
      case "extract":
        return t.phaseExtract;
      case "copy":
        return t.phaseCopy;
      case "done":
        return t.phaseDone;
      default:
        return t.phaseDownload;
    }
  };

  /**
   * 进度条怎么画，分三种：
   *   - 有总量（下载刚拿到 `Content-Length`）：真的百分比；
   *   - 在解压（`total` 是**文件个数**，逐条回调给的）：按文件数算百分比，明细写「137 / 902 个文件」；
   *   - 什么都不知道（总量为 0）：来回滑的滑块 —— 不编一个假的百分比。
   * 下载与解压的百分比不能混着画，所以两处的明细文案也分开。
   */
  const total = progress?.totalBytes ?? 0;
  const percent =
    !progress || total <= 0
      ? null
      : Math.max(0, Math.min(100, Math.round((progress.bytes / total) * 100)));
  const isExtracting = progress?.phase === "extract";

  return (
    <main className="page emu-page">
      <header className="emu-head">
        <div className="emu-title">
          <h2>{text().tabs.emulators}</h2>
          <p className="emu-sub">{loaded ? t.sub : t.phaseResolve}</p>
        </div>
        {measuring && <span className="emu-note">{t.measuring}</span>}
        <button type="button" className="emu-selfcheck" data-focusable ref={headRef} onClick={() => void selfCheck()}>
          <RefreshIcon />
          {t.refresh}
        </button>
      </header>

      {/*
        安装位置那一行：默认是**第一块非系统盘**（掌机上就是 D:）—— 但这里不写死 D:，
        盘符与「是不是默认」都以后端读到的为准。已经装好的不会因为改这里而搬家（界面上写明）。
      */}
      <section className="emu-root" aria-label={t.rootTitle}>
        <span className="emu-root-label">{t.rootTitle}</span>
        <span className="emu-root-path" title={root?.root ?? ""}>
          {root?.root || "—"}
        </span>
        <span className={`emu-root-tag${root?.custom ? " is-custom" : ""}`}>
          {root?.custom ? t.rootCustom : t.rootDefault}
        </span>
        {/*
          量体积单独一颗按钮：「递归数一遍 RetroArch 目录」要几秒，不该跟着每次切页一起跑
          （账本里存着上次量到的数，卡片先画那个）。
        */}
        {rows.some((row) => row.installed) && (
          <button
            type="button"
            className="emu-btn"
            data-focusable
            disabled={measuring}
            onClick={() => void measure()}
          >
            {measuring ? t.measuring : t.measure}
          </button>
        )}
        <button type="button" className="emu-btn" data-focusable onClick={() => setPicking(true)} disabled={!root?.supported}>
          {t.rootChange}
        </button>
        <button
          type="button"
          className="emu-btn"
          data-focusable
          disabled={!root?.supported || !root?.custom}
          onClick={() => void applyRoot("")}
        >
          {t.rootReset}
        </button>
        <span className="emu-root-hint">{t.rootHint}</span>
      </section>

      {note && <p className="emu-note-line">{note}</p>}

      {loaded && rows.length === 0 && <p className="emu-note-line">{t.empty}</p>}

      <div className="emu-grid">
        {rows.map((row) => {
          // `installingId` 非空 = 有安装正在跑（可能是别的卡）。后端也有一道闸门（一次只装一个），
          // 这里禁掉别的卡是为了不让用户点了才发现装不了。
          const installingSomething = Boolean(installingId);
          const isBusy = busy === row.id || installingId === row.id;
          const blockedByOther = installingSomething && !isBusy;
          const manual = Boolean(row.manualReason);
          return (
            <article
              key={row.id}
              className={`emu-card${row.installed ? " is-installed" : ""}${manual ? " is-manual" : ""}`}
            >
              <div className="emu-card-top">
                <span className="emu-badge">{row.badge}</span>
                <div className="emu-card-head">
                  <h3>{row.name}</h3>
                  <p className="emu-card-emu">
                    {row.emulator}
                    <span className="emu-card-vendor"> · {row.vendor}</span>
                  </p>
                </div>
              </div>

              <p className="emu-card-desc">{row.desc}</p>
              {row.note && <p className="emu-card-note">{row.note}</p>}
              {manual && <p className="emu-card-note">{row.manualReason}</p>}

              {/* 状态行：装没装、哪一版、多大。还没读完这一页时写「—」，不写「未安装」。 */}
              {row.installed && root?.root && !row.dir.toLowerCase().startsWith(root.root.toLowerCase()) && (
                <p className="emu-card-elsewhere">{t.elsewhere(row.dir)}</p>
              )}
              <p className="emu-card-state">
                {!loaded
                  ? "—"
                  : row.installed
                    ? row.version
                      ? t.stateInstalled(row.version, row.bytes ? formatSize(row.bytes) : t.sizeUnknown)
                      : t.stateInstalledNoVersion(row.bytes ? formatSize(row.bytes) : t.sizeUnknown)
                    : t.stateMissing}
              </p>

              {isBusy && progress && (
                <div className="emu-progress">
                  {/*
                    上面一行是「在干嘛 + 百分比」，下面一行是明细。解压那一步的明细是
                    「137 / 902 个文件」（逐条回调给不了字节数），不能跟下载的字节数混着说；
                    百分比也不能重复写两遍，所以它在上面那一行，明细里就只说数量。
                  */}
                  <div className="emu-progress-row">
                    <span className="emu-progress-phase">{phaseLabel(progress.phase)}</span>
                    <span className="emu-progress-num">
                      {percent !== null
                        ? `${percent}%`
                        : progress.phase === "download"
                          ? t.progressUnknown(formatSize(progress.bytes))
                          : t.progressWorking}
                    </span>
                  </div>
                  <div className="emu-progress-track">
                    <div
                      className={`emu-progress-fill${percent === null ? " is-indeterminate" : ""}`}
                      style={percent === null ? undefined : { width: `${percent}%` }}
                    />
                  </div>
                  {percent !== null && (
                    <p className="emu-progress-bytes">
                      {isExtracting
                        ? t.progressFiles(progress.bytes, progress.totalBytes)
                        : t.progressBytes(formatSize(progress.bytes), formatSize(progress.totalBytes))}
                    </p>
                  )}
                </div>
              )}

              <div className="emu-actions">
                {manual ? (
                  <>
                    {/* 官网还在就给出口；连官网都没了（Switch）就只留个标签，不指路。 */}
                    {row.manualUrl && (
                      <button
                        type="button"
                        className="emu-btn is-primary"
                        data-focusable
                        onClick={() => void openSite(row)}
                      >
                        {t.openSite}
                      </button>
                    )}
                    <span className="emu-tag">{t.manualTag}</span>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="emu-btn is-primary"
                      data-focusable
                      disabled={isBusy || blockedByOther || !row.supported}
                      onClick={() => void install(row)}
                    >
                      {row.installed ? t.reinstall : t.install}
                    </button>
                    {/* 「游戏列表」：列的是这个平台的 ROM 目录，和模拟器装没装无关，
                        所以不跟着 installed 走。在线来源接上之前，里面只有本机已有的文件。 */}
                    <button
                      type="button"
                      className="emu-btn"
                      data-focusable
                      disabled={isBusy}
                      onClick={() => void openRoms(row)}
                    >
                      {t.roms}
                    </button>
                    {row.installed && (
                      <>
                        <button
                          type="button"
                          className="emu-btn"
                          data-focusable
                          disabled={isBusy}
                          onClick={() => void launch(row)}
                        >
                          {t.launch}
                        </button>
                        <button
                          type="button"
                          className="emu-btn"
                          data-focusable
                          disabled={isBusy}
                          onClick={() => void openFolder(row)}
                        >
                          {t.openFolder}
                        </button>
                        <button
                          type="button"
                          className="emu-btn is-danger"
                          data-focusable
                          disabled={isBusy}
                          onClick={() => setConfirming(row.id)}
                        >
                          {t.uninstall}
                        </button>
                      </>
                    )}
                    {isBusy && (
                      <button
                        type="button"
                        className="emu-btn"
                        data-focusable
                        onClick={() => void invoke("emulator_cancel")}
                      >
                        {t.cancel}
                      </button>
                    )}
                  </>
                )}
              </div>

              {/*
                卸载的二次确认**做在卡片里**，不弹窗：卸载会连这个模拟器目录里的存档一起删，
                所以要问一次；但页面上一共就六张卡，弹窗那种打断比一行字更烦。
              */}
              {confirming === row.id && (
                <div className="emu-confirm">
                  <p>{t.uninstallConfirm}</p>
                  <div className="emu-actions">
                    <button
                      type="button"
                      className="emu-btn is-danger"
                      data-focusable
                      onClick={() => void uninstall(row)}
                    >
                      {t.uninstallYes}
                    </button>
                    <button
                      type="button"
                      className="emu-btn"
                      data-focusable
                      onClick={() => setConfirming("")}
                    >
                      {t.uninstallNo}
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {!loaded && rows.length === 0 && <p className="emu-note-line">{t.phaseResolve}</p>}

      {romsFor && (
        <RomsPanel
          title={romsFor.name}
          dir={romRoot ? `${romRoot}\\${romsFor.romDir}` : ""}
          onClose={() => setRomsFor(null)}
        />
      )}

      {picking && (
        <FolderPicker
          title={t.rootTitle}
          start={root?.root}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setPicking(false);
            void applyRoot(path);
          }}
        />
      )}
    </main>
  );
}
