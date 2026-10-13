import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playSfx } from "../audio/sfx";
import { setFileActions } from "../files/actions";
import { FileCrumbs, FilePane, formatBytes, formatTime, type FileLayout } from "../files/FilePane";
import {
  EyeIcon,
  FolderIcon,
  KeyboardIcon,
  SearchIcon,
  SortIcon,
  UpIcon,
} from "../components/NavIcons";
import { KeyCap } from "../components/KeyCap";
import {
  jobId,
  toFileError,
  useFileBrowser,
  isArchiveName,
  showSoftKeyboard,
  type Conflict,
  type FileEntry,
  type FileErrorInfo,
  type FileProperties,
  type SearchHit,
  type SortKey,
  type TransferItem,
} from "../files/useFileBrowser";
import { forgetJob, useFileJobs } from "../files/useFileJobs";
import { cancelJob, JobsPanel } from "../files/JobsPanel";
import { ConfirmSummary } from "../files/ConfirmSummary";
import { PreviewPanel } from "../files/PreviewPanel";
import { TaskGrid } from "../files/TaskGrid";
import { TaskWizard } from "../files/TaskWizard";
import { taskCtx, externalDrives } from "../files/tasks/env";
import type { TaskCtx, TaskDef, TaskRuntime } from "../files/tasks/types";
import { text } from "../i18n";

type PaneId = "left" | "right";
type Naming = "dir" | "file" | null;
type EditorState = { path: string; name: string; text: string };
type BatchMode = "original" | "number" | "replace";

/** 「显示隐藏文件」记在这儿：下次打开文件页还是上次的选择。 */
const SHOW_HIDDEN_KEY = "files-show-hidden";

/** 预览面板开不开也记住（画板 F2 的「预览 开」开关）。 */
const PREVIEW_KEY = "handheld-launcher.files.preview";

/** 浏览 / 任务 / 任务中心：三个视图共用一条页面。 */
type FileView = "browse" | "tasks" | "jobs";

/** 剩余时间写成 `0:45` / `12:07`：只有数字和冒号，不用翻译。 */
function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

type BatchForm = {
  items: FileEntry[];
  mode: BatchMode;
  base: string;
  start: string;
  find: string;
  replace: string;
};

type SearchForm = {
  id: string;
  query: string;
  busy: boolean;
  hits: SearchHit[] | null;
  error: string;
};

type PropsState = { path: string; name: string; info: FileProperties | null; busy: boolean; error: string };
type PlacesState = { rows: FileEntry[]; busy: boolean; error: string };
type ConflictState = {
  items: TransferItem[];
  mode: "copy" | "move";
  destDir: string;
  pane: PaneId;
  count: number;
};

const LAYOUT_KEY = "handheld-launcher.files.layout";
const DUAL_KEY = "handheld-launcher.files.dual";

function loadLayout(): FileLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function loadDual(): boolean {
  try {
    return localStorage.getItem(DUAL_KEY) === "1";
  } catch {
    return false;
  }
}

/** 失败原因翻成人话：同是「操作失败」，占用 / 权限 / 盘满该给的建议完全不同。 */
function describeError(err: FileErrorInfo): string {
  const t = text().files;
  if (err.reason === "denied") return `${err.message} ${t.hintDenied}`;
  if (err.reason === "busy") return `${err.message} ${t.hintBusy}`;
  if (err.reason === "space") return `${err.message} ${t.hintSpace}`;
  if (err.reason === "toolong") return `${err.message} ${t.hintToolong}`;
  return err.message;
}

function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/**
 * 两个路径是不是同一个位置。只给「位置栏高亮哪一项」用：
 * 后端给的 `C:\Users\qubo\Downloads` 和当前目录可能是大小写 / 结尾斜杠的差别，
 * 直接字符串比较会出现「明明就在下载里，左边却没高亮」。
 */
function samePath(a: string, b: string): boolean {
  const norm = (v: string) => v.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 批量改名的计划。**算法只有这一份**：预览显示什么，后端就按什么落地
 * （Rust 的 `file_rename_many` 只负责安全地改名），免得「预览 X、执行成 Y」。
 */
function batchPlan(form: BatchForm): { from: string; to: string; name: string }[] {
  const pairs: { from: string; to: string; name: string }[] = [];
  const start = Math.max(0, Number.parseInt(form.start, 10) || 1);
  form.items.forEach((entry, index) => {
    const [stem, ext] = splitName(entry.name);
    let next = entry.name;
    if (form.mode === "original") {
      next = `${stem} ${start + index}${ext}`;
    } else if (form.mode === "number") {
      next = `${form.base.trim() || stem} ${start + index}${ext}`;
    } else {
      if (!form.find) return;
      // 顺手挡掉系统不允许的字符，免得整批被后端拒掉。
      const replaced = stem.replaceAll(form.find, form.replace).replace(/[\\/:*?"<>|]/g, "_").trim();
      if (!replaced) return;
      next = `${replaced}${ext}`;
    }
    if (next !== entry.name) pairs.push({ from: entry.path, to: next, name: entry.name });
  });
  return pairs;
}

/**
 * K7 底部操作条的按键角标（画板 K7 画了六处：X 复制 / Y 剪切 / ☰ 粘贴 /
 * 长按 A 重命名 / 长按 B 删除 / LB 新建文件夹）。
 *
 * 这里**只写真绑上了的**按键，而且只在对应 chip 真的能用时才画角标 ——
 * 0.1.60 那次一颗角标都没画，就是因为当时一个手柄绑定都没改，挂上去全是假提示。
 * 这一版按规格书 §13.2 补了两条（文件页：X 复制 / Y 剪切，见 `files/actions.ts`）；
 * 剩下四条**故意没做**，理由写在这儿免得以后被当成漏做：
 *   - `☰ 粘贴`：☰（Share / View）在全局是「双击开设置抽屉」，让它在这页变成粘贴，
 *     就成了同一颗键两种语义；粘贴本来就在操作条上，不缺入口。
 *   - `LB 新建文件夹`：LB / RB 在全局是「切一级分区」（App.tsx 的 shiftTab），
 *     和画板这条冲突；规格书 §13.2 的全局那一列也是切分区，以它为准。
 *   - `长按 A 重命名` / `长按 B 删除`：A 现在是**按下即打开**，要支持长按就得把确认
 *     动作押后到松手（否则长按会先打开文件再改名）；这一改动的是全局确认手感，
 *     不做。删除/重命名都在操作条上，也都在 ☰ / Y 菜单里。
 */
const CHIP_KEYS = {
  copy: "X",
  cut: "Y",
} as const;

/** 角标：字母键与 ≡ 走 Tabler 图标，肩键（多字符）仍用矩形圆角文字 —— 同提示条。 */
function KeyBadge({ label }: { label: string }) {
  return <KeyCap label={label} className="k7-key" />;
}

export function FilesPage() {
  const [dual, setDual] = useState(loadDual);
  const [activePane, setActivePane] = useState<PaneId>("left");
  const [layout, setLayout] = useState<FileLayout>(loadLayout);
  const [picked, setPicked] = useState<Record<PaneId, string[]>>({ left: [], right: [] });
  const [selectMode, setSelectMode] = useState(false);
  // 画板 K7 之上的三个视图与预览开关（文件管理增强）。默认留在浏览器 ——
  // 老用户打开文件页的第一反应还是「我要找文件」，不该被塞进任务向导。
  const [view, setView] = useState<FileView>("browse");
  const [task, setTask] = useState<TaskDef | null>(null);
  const [ctx, setCtx] = useState<TaskCtx | null>(null);
  const [runtime, setRuntime] = useState<TaskRuntime | null>(null);
  const [preview, setPreview] = useState(() => {
    try {
      return localStorage.getItem(PREVIEW_KEY) === "1";
    } catch {
      return false;
    }
  });
  // 预览跟着**焦点**走，不是跟着选中走：焦点一动就换预览是这件事的全部意义。
  const [focusEntry, setFocusEntry] = useState<FileEntry | null>(null);
  /** 向导的 B 键由它接走（向导每次渲染把自己最新的 `back` 放进来）。 */
  const wizardBack = useRef<() => boolean>(() => false);
  // 排序：画板 K7 的头部只有一颗「排序」按钮，四个排序键收在它展开的那一行里。
  const [sortOpen, setSortOpen] = useState(false);

  const [menu, setMenu] = useState<FileEntry | null>(null);
  const [naming, setNaming] = useState<Naming>(null);
  const [draft, setDraft] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [trash, setTrash] = useState<FileEntry[] | null>(null);
  const [rename, setRename] = useState<{ entry: FileEntry; draft: string; pane: PaneId } | null>(null);
  const [batch, setBatch] = useState<BatchForm | null>(null);
  /** 批量改名遇到重名时怎么办（画板 F4 的三枚 chip）。默认「跳过」—— 最保守的那个。 */
  const [batchConflict, setBatchConflict] = useState<"skip" | "number" | "replace">("skip");
  const [props, setProps] = useState<PropsState | null>(null);
  const [search, setSearch] = useState<SearchForm | null>(null);
  // 位置有两个落点：单栏时是左边的常驻一栏（画板 K7），双栏时那栏没地方放，仍旧走弹窗。
  // 两者分开存 —— 弹窗那个 null 表示「没开」，栏里那个永远是对象（有 busy / error 要显示）。
  const [placesDialog, setPlacesDialog] = useState<PlacesState | null>(null);
  const [places, setPlaces] = useState<PlacesState>({ rows: [], busy: true, error: "" });
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  /**
   * 「对后续所有冲突使用此选择」（改造包 §5.2，增强 7）。
   *
   * 合并一个 200 项的文件夹时逐个确认是灾难：勾上这个之后，后面的同名冲突直接按同一策略处理，
   * 不再弹层。存 ref 不存 state：它是**一次性开关**，变了不需要重渲染。
   * 「本次会话」的有效期：页面不卸载就一直有效（切页会卸载 —— 那时清空更安全）。
   */
  const [conflictApplyAll, setConflictApplyAll] = useState(false);
  const conflictPolicy = useRef<Conflict | null>(null);
  /**
   * 大批量操作前的确认（改造包 §5.3，增强 8）。
   *
   * 小批量（< 10 个文件且 < 100 MB）**不问**：问一次反而烦。删除不走这里 ——
   * 它有自己的确认层（`trash`），而且不管多小都要问。
   */
  const [confirm, setConfirm] = useState<{
    items: TransferItem[];
    mode: "copy" | "move";
    destDir: string;
    pane: PaneId;
    count: number;
    bytes: number;
    /** 目标里已经有多少个同名（0 就是「不需要」那一格）。 */
    collisions: number;
  } | null>(null);
  const [formError, setFormError] = useState("");

  const leftList = useRef<HTMLDivElement | null>(null);
  const rightList = useRef<HTMLDivElement | null>(null);
  const leftFirst = useRef<HTMLButtonElement | null>(null);
  const rightFirst = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<FileEntry[]>([]);
  const anchorRef = useRef<Record<PaneId, number>>({ left: -1, right: -1 });
  const jobPanes = useRef<Record<string, PaneId>>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const batchRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const trashCancelRef = useRef<HTMLButtonElement>(null);

  /**
   * 丢掉这一栏的选中，并退出选择模式。两处在用：换目录（`onNavigate`）、用户按「取消全选」。
   *
   * 换目录**必须在导航那一刻**清掉，不能等 effect：新目录的第一行会自动拿到焦点，
   * 那时要是还在选择模式，第一行就会被顺手选上（用户看到的是莫名其妙的勾）。
   * 退出选择模式同样必须：留在模式里 A 只会切换选中，用户会以为文件打不开了。
   */
  const dropSelection = useCallback((pane: PaneId) => {
    setPicked((current) => (current[pane].length === 0 ? current : { ...current, [pane]: [] }));
    anchorRef.current[pane] = -1;
    setSelectMode(false);
  }, []);

  /**
   * 显示隐藏文件：默认关。选择记在 localStorage 里 —— 掌机上 `AppData` 这类目录
   * 平时不想看见，但真去翻的时候希望下次进来还是开着的。
   */
  const [showHidden, setShowHidden] = useState(() => {
    try {
      return localStorage.getItem(SHOW_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleHidden = useCallback(() => {
    setShowHidden((on) => {
      try {
        localStorage.setItem(SHOW_HIDDEN_KEY, on ? "0" : "1");
      } catch {
        /* 隐私模式下写不了就只当次生效 */
      }
      return !on;
    });
  }, []);

  const left = useFileBrowser({
    cacheKey: "left",
    onNavigate: () => dropSelection("left"),
    showHidden,
  });
  const right = useFileBrowser({
    cacheKey: "right",
    onNavigate: () => dropSelection("right"),
    showHidden,
  });

  const browsers: Record<PaneId, ReturnType<typeof useFileBrowser>> = { left, right };
  const active = browsers[activePane];
  const other = browsers[activePane === "left" ? "right" : "left"];
  const activeLabel = activePane === "left" ? text().files.leftPane : text().files.rightPane;
  const otherLabel = activePane === "left" ? text().files.rightPane : text().files.leftPane;
  const pickedNow = picked[activePane];
  const entries = active.entries;
  const dialogOpen =
    menu !== null ||
    naming !== null ||
    editor !== null ||
    trash !== null ||
    rename !== null ||
    batch !== null ||
    props !== null ||
    search !== null ||
    placesDialog !== null ||
    conflict !== null;

  const jobs = useFileJobs();
  const running = jobs.filter((job) => job.phase === "scan" || job.phase === "run");

  // 任务层要的「已知目录 / 游戏库 / 外部盘」：进页面读一次，之后由 `tasks/env` 自己缓存 10 秒。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ready = await taskCtx();
        if (!alive) return;
        setCtx(ready);
        // 外部盘列表是给卡片置灰用的（没插 U 盘时「U 盘」那张要灰掉并说明原因）。
        setRuntime({ external: await externalDrives(ready) });
      } catch {
        /* 读不到就保持 null：卡片先按可用渲染，真有问题会在向导里如实说出来 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 任务跑完（目录变了）之后两栏都重读一遍。 */
  const reloadBoth = useCallback(() => {
    void left.reload();
    void right.reload();
  }, [left, right]);

  /**
   * 左栏「位置」（画板 K7 的常驻左栏）：进页面取一次，切回单栏时再取一次。
   *
   * 为什么不跟着当前目录重取：这六个位置是固定的（下载 / 文档 / 图片 / ROM / Steam 库 / U 盘），
   * 换目录只影响「哪一个高亮」，那是本地比一下 path 就知道的事，不该每次都问一遍后端。
   * 双栏时左栏被两栏顶掉了（位置改从头部那颗按钮进弹窗），所以这时不取。
   */
  useEffect(() => {
    if (dual) return;
    let alive = true;
    setPlaces((current) => ({ ...current, busy: current.rows.length === 0, error: "" }));
    void left
      .listPlaces()
      .then((rows) => {
        if (alive) setPlaces({ rows, busy: false, error: "" });
      })
      .catch((err) => {
        if (alive) setPlaces({ rows: [], busy: false, error: describeError(toFileError(err)) });
      });
    return () => {
      alive = false;
    };
    // listPlaces 是个 useCallback（依赖 preview/tree），换页面不会重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dual]);

  // 手柄回调在 rAF 里读，闭包会旧：要用的东西都过一遍 ref（老代码也是这样）。
  const actionsRef = useRef({ dialogOpen, selectMode, dual, activePane });
  actionsRef.current = { dialogOpen, selectMode, dual, activePane };
  const paneRef = useRef({ left: left.entries, right: right.entries });
  paneRef.current = { left: left.entries, right: right.entries };

  const listOf = (pane: PaneId) => (pane === "left" ? leftList : rightList);

  /** 焦点现在在哪个栏的哪一行（没有就是 null）。 */
  const focusedRow = useCallback((): { pane: PaneId; index: number } | null => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const holder = el.closest("[data-pane]");
    const pane = holder?.getAttribute("data-pane");
    const raw = el.getAttribute("data-file-index");
    const index = raw == null ? Number.NaN : Number(raw);
    if ((pane !== "left" && pane !== "right") || !Number.isFinite(index) || index < 0) return null;
    return { pane, index };
  }, []);


  /** 选中/取消一项。带 `range` 就是从锚点选到这里（鼠标 Shift、手柄靠选择模式扫过）。 */
  const pick = useCallback(
    (pane: PaneId, index: number, options?: { range?: boolean }) => {
      const rows: FileEntry[] = paneRef.current[pane];
      const entry = rows[index];
      if (!entry) return;
      setPicked((current) => {
        const on = current[pane];
        if (options?.range) {
          const anchor = anchorRef.current[pane] >= 0 ? anchorRef.current[pane] : index;
          const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
          const range = rows.slice(from, to + 1).map((row) => row.path);
          return { ...current, [pane]: [...new Set([...on, ...range])] };
        }
        return {
          ...current,
          [pane]: on.includes(entry.path) ? on.filter((path) => path !== entry.path) : [...on, entry.path],
        };
      });
      anchorRef.current[pane] = index;
    },
    [],
  );


  const selectAll = useCallback(
    (pane: PaneId) => {
      const rows: FileEntry[] = paneRef.current[pane];
      const paths = rows.map((row) => row.path);
      setPicked((current) => {
        const every = paths.length > 0 && paths.every((path) => current[pane].includes(path));
        return { ...current, [pane]: every ? [] : paths };
      });
    },
    [],
  );



  const setNote = (message: string) => active.setNote(message);

  /** 交给后端搬（双栏时目标可以是另一栏的目录）。 */
  async function runTransfer(
    items: TransferItem[],
    mode: "copy" | "move",
    destDir: string,
    pane: PaneId,
    policy: Conflict,
  ) {
    if (items.length === 0) return;
    const label =
      items.length === 1 ? text().files.quoted(items[0].name) : text().files.itemCount(items.length);
    const id = await browsers[pane].startTransfer(items, mode, policy, destDir);
    if (!id) return;
    jobPanes.current[id] = pane;
    browsers[pane].setNote(mode === "copy" ? text().files.startCopy(label) : text().files.startMove(label));
  }

  /**
   * 这批操作算不算「大批量」（改造包 §5.3）：≥ 10 项，或者 ≥ 100 MB。
   *
   * 大小只能靠**当前目录里那一行**的字节数估：文件夹在列表里没有大小（要走盘），
   * 所以它是按 0 算的 —— 摘要上那一格因此是**下限**，不是谎话。
   */
  function bigBatch(items: TransferItem[], pane: PaneId): { bytes: number } | null {
    const rows = paneRef.current[pane];
    const bytes = items.reduce(
      (sum, item) => sum + (rows.find((row) => row.path === item.path)?.bytes ?? 0),
      0,
    );
    if (items.length >= 10 || bytes >= 100 * 1024 * 1024) return { bytes };
    return null;
  }

  /**
   * 目标里已经有同名的吗？有就先问（覆盖 / 跳过 / 保留两者），没有就直接搬。
   * 后端也会再判一次，这里只是**先问清楚**，别等拷了一半才发现要覆盖。
   */
  async function transferSelection(
    items: TransferItem[],
    mode: "copy" | "move",
    destDir: string,
    pane: PaneId,
    destRows?: FileEntry[],
  ) {
    if (items.length === 0) return;
    if (!destDir) {
      setNote(text().files.enterFolderFirst);
      return;
    }
    const rows = destRows ?? browsers[pane].entries;
    const names = new Set(rows.map((row) => row.name.toLowerCase()));
    const collisions = items.filter((item) => names.has(item.name.toLowerCase())).length;
    if (collisions > 0) {
      // 上一次勾了「对后续所有冲突使用此选择」：按那个策略直接办，不再弹层。
      if (conflictPolicy.current) {
        await runTransfer(items, mode, destDir, pane, conflictPolicy.current);
        return;
      }
      // 冲突层本身就是一次确认（它把「有几项同名、怎么办」说清楚了），不再叠一层摘要。
      setConflict({ items, mode, destDir, pane, count: collisions });
      return;
    }
    const big = bigBatch(items, pane);
    if (big) {
      setConfirm({ items, mode, destDir, pane, count: items.length, bytes: big.bytes, collisions: 0 });
      return;
    }
    await runTransfer(items, mode, destDir, pane, "keep");
  }

  async function pasteInto(pane: PaneId, destDir: string | null) {
    if (!destDir) {
      setNote(text().files.enterFolderFirst);
      return;
    }
    const browser = browsers[pane];
    const items = browser.clip?.items ?? [];
    if (items.length === 0) return;
    const rows =
      destDir === browser.location ? browser.entries : browsers[pane === "left" ? "right" : "left"].entries;
    const names = new Set(rows.map((row) => row.name.toLowerCase()));
    const collisions = items.filter((item) => names.has(item.name.toLowerCase())).length;
    const mode = browser.clip?.mode ?? "copy";
    if (collisions > 0) {
      if (conflictPolicy.current) {
        await runTransfer(items, mode, destDir, pane, conflictPolicy.current);
        return;
      }
      setConflict({ items, mode, destDir, pane, count: collisions });
      return;
    }
    const big = bigBatch(items, pane);
    if (big) {
      setConfirm({ items, mode, destDir, pane, count: items.length, bytes: big.bytes, collisions: 0 });
      return;
    }
    const id = await browser.paste("keep");
    if (id) jobPanes.current[id] = pane;
  }

  function openEntry(entry: FileEntry, pane: PaneId) {
    setMenu(null);
    /*
     * 选择模式里 **A = 选中/取消这一项**，不打开它。
     *
     * 用户 2026-10-12：「按 X 之后需要按 A 键才会选中，否则不选中，只是移动」——
     * 选中动作只留 A 一条路；选完按 Y 出菜单做删除/复制，或再按 X 退出选择模式。
     */
    if (selectMode) {
      const index = paneRef.current[pane].findIndex((row) => row.path === entry.path);
      if (index >= 0) pick(pane, index);
      return;
    }
    if (entry.kind === "dir") {
      browsers[pane].enter(entry);
      return;
    }
    void browsers[pane]
      .openExternal(entry)
      .catch((err: unknown) => setNote(describeError(toFileError(err))));
  }

  const targetsFor = (entry: FileEntry, pane: PaneId): FileEntry[] => {
    const on = picked[pane];
    if (!on.includes(entry.path)) return [entry];
    return paneRef.current[pane].filter((row) => on.includes(row.path));
  };

  /** Y：打开焦点项的菜单；焦点不在行上就交给别人处理。 */
  function openMenu() {
    const spot = focusedRow();
    if (!spot) return false;
    const entry = paneRef.current[spot.pane][spot.index];
    if (!entry) return false;
    setActivePane(spot.pane);
    setMenu(entry);
    return true;
  }

  /**
   * X：进 / 出选择模式。**进去之后不选中任何东西** —— 选哪一项由 A 决定。
   *
   * 用户 2026-10-12 的真机反馈：「一旦我按 X，那么我聚焦移动的项就都会被多选，很容易误删。
   * 我建议你改成：按 X 之后需要按 A 键才会选中，否则不选中，只是移动」。
   * 老实现是"进模式即选中当前项 + 焦点走到哪选到哪"（手柄没有 Shift，本想做区间选择），
   * 但代价是**只要移动就会选上**，想删一项却划过去三行，就多删两个——误删比"选起来慢"糟得多。
   */
  function toggleSelect() {
    const spot = focusedRow();
    if (!spot) return false;
    setActivePane(spot.pane);
    if (!selectMode) {
      setSelectMode(true);
      anchorRef.current[spot.pane] = spot.index;
      return true;
    }
    exitSelection();
    return true;
  }

  function exitSelection() {
    setSelectMode(false);
    setPicked({ left: [], right: [] });
  }

  function back(): boolean {
    // 任务向导开着的时候，B 归它（上一步 / 取消 / 退出向导）—— 它是页面自己的一层，
    // 排在所有对话框之前：向导里那几张弹层（选文件夹）由向导自己先接。
    if (view === "tasks" && task) return wizardBack.current();
    // 任务中心：B 回到浏览视图（这里没有「上一层文件夹」可言）。
    if (view === "jobs") {
      setView("browse");
      return true;
    }
    if (confirm) {
      setConfirm(null);
      return true;
    }
    if (conflict) {
      setConflict(null);
      return true;
    }
    // 排序行是页面自己展开的一层，B 先收它（再按 B 才是「返回上一层」）
    if (sortOpen) {
      setSortOpen(false);
      return true;
    }
    if (placesDialog) {
      setPlacesDialog(null);
      return true;
    }
    if (search) {
      if (search.busy) void active.cancel(search.id);
      setSearch(null);
      return true;
    }
    if (props) {
      setProps(null);
      return true;
    }
    if (batch) {
      setBatch(null);
      setFormError("");
      return true;
    }
    if (rename) {
      setRename(null);
      setFormError("");
      return true;
    }
    if (trash) {
      setTrash(null);
      return true;
    }
    if (editor) {
      if (document.activeElement instanceof HTMLTextAreaElement) {
        saveRef.current?.focus();
        return true;
      }
      setEditor(null);
      return true;
    }
    if (naming) {
      if (document.activeElement instanceof HTMLInputElement) {
        renameRef.current?.focus();
        return true;
      }
      setNaming(null);
      setDraft("");
      setFormError("");
      return true;
    }
    if (menu) {
      setMenu(null);
      return true;
    }
    if (selectMode) {
      exitSelection();
      return true;
    }
    void active.up();
    return true;
  }

  function dismissAll() {
    setMenu(null);
    setNaming(null);
    setEditor(null);
    setTrash(null);
    setRename(null);
    setBatch(null);
    setProps(null);
    setSearch(null);
    setPlacesDialog(null);
    setConflict(null);
    setSortOpen(false);
    setDraft("");
    setFormError("");
    setSelectMode(false);
  }

  async function submitName() {
    if (!naming) return;
    try {
      if (naming === "dir") {
        await active.createDir(draft);
      } else {
        const path = await active.createFile(draft);
        setEditor({ path, name: draft.trim(), text: "" });
      }
      setNaming(null);
      setDraft("");
      setFormError("");
    } catch (err) {
      setFormError(describeError(toFileError(err)));
    }
  }

  async function submitRename() {
    if (!rename) return;
    try {
      await browsers[rename.pane].rename(rename.entry, rename.draft);
      setRename(null);
      setFormError("");
    } catch (err) {
      // 失败就把弹窗留着、把原因写在里面 —— 关掉弹窗再让人重新找名字最烦。
      setFormError(describeError(toFileError(err)));
    }
  }

  async function submitBatch() {
    if (!batch) return;
    // 走 `batchRunPairs`（对照表算出来的最终计划），不重新跑一遍 `batchPlan`：
    // 那样「自动编号 / 跳过 / 覆盖」这三枚 chip 就白点了。
    const plan = batchRunPairs;
    if (plan.length === 0) {
      setFormError(text().files.batchEmpty);
      return;
    }
    try {
      // 「覆盖」：先把同名的旧文件删掉（改名本身不覆盖，目标已存在会直接失败）。
      // 删除放最前面、一个个来，任何一个删不掉就整批停下 —— 免得改了一半。
      for (const row of plan) {
        if (!row.victim) continue;
        await invoke("file_delete", { path: row.victim, permanent: false });
      }
      const report = await active.renameMany(plan.map(({ from, to }) => ({ from, to })));
      setBatch(null);
      setFormError("");
      setNote(
        report.failures.length > 0
          ? `${text().files.renamedMany(report.done)} ${report.failures[0].message}`
          : text().files.renamedMany(report.done),
      );
    } catch (err) {
      setFormError(describeError(toFileError(err)));
    }
  }

  async function edit(entry: FileEntry) {
    setMenu(null);
    try {
      const body = await active.readText(entry);
      setEditor({ path: entry.path, name: entry.name, text: body });
    } catch (err) {
      setNote(describeError(toFileError(err)));
    }
  }

  async function openProperties() {
    const spot = focusedRow();
    const entry = spot ? paneRef.current[spot.pane][spot.index] : menu;
    const pane = spot?.pane ?? activePane;
    if (!entry) return;
    await openPropertiesFor(entry, pane);
  }

  /**
   * 看某一项的属性。抽出来是因为底部操作条的「属性」chip 要按**选中项**来（而菜单那颗
   * 按键走的是焦点项）：两处共用一段逻辑，免得改一处漏一处。
   */
  async function openPropertiesFor(entry: { path: string; name: string }, pane: PaneId) {
    setMenu(null);
    setProps({ path: entry.path, name: entry.name, info: null, busy: true, error: "" });
    try {
      const info = await browsers[pane].properties(entry.path);
      setProps({ path: entry.path, name: entry.name, info, busy: false, error: "" });
    } catch (err) {
      setProps({
        path: entry.path,
        name: entry.name,
        info: null,
        busy: false,
        error: describeError(toFileError(err)),
      });
    }
  }

  async function openPlaces() {
    setMenu(null);
    setPlacesDialog({ rows: [], busy: true, error: "" });
    try {
      const rows = await active.listPlaces();
      setPlacesDialog({ rows, busy: false, error: "" });
    } catch (err) {
      setPlacesDialog({ rows: [], busy: false, error: describeError(toFileError(err)) });
    }
  }

  function openSearch() {
    setMenu(null);
    setSearch({ id: jobId("search"), query: "", busy: false, hits: null, error: "" });
  }

  async function runSearch() {
    if (!search) return;
    const query = search.query.trim();
    if (!query) return;
    const id = search.id;
    setSearch({ ...search, busy: true, hits: null, error: "" });
    try {
      const hits = await active.search(query, id);
      setSearch((current) => (current && current.id === id ? { ...current, busy: false, hits } : current));
    } catch (err) {
      const info = toFileError(err);
      setSearch((current) =>
        current && current.id === id
          ? {
              ...current,
              busy: false,
              error: info.reason === "cancelled" ? text().files.reasonCancelled : describeError(info),
            }
          : current,
      );
    }
  }

  // 任务收尾：刷新两栏、把结果写成一行提示、把进度面板收起来。
  useEffect(() => {
    for (const job of jobs) {
      if (job.phase === "scan" || job.phase === "run") continue;
      const pane = jobPanes.current[job.id];
      if (!pane) continue;
      delete jobPanes.current[job.id];
      const browser = browsers[pane];
      if (job.phase === "done") {
        browser.setNote(
          job.skipped > 0
            ? text().files.transferDoneSkipped(job.itemsDone, job.skipped)
            : text().files.transferDone(job.itemsDone),
        );
        playSfx("paste");
      } else if (job.phase === "cancelled") {
        browser.setNote(text().files.transferCancelled(job.itemsDone));
      } else {
        browser.setNote(describeError({ reason: job.reason, message: job.message }));
      }
      forgetJob(job.id);
      // 走得那边少了几项，来的那边多了几项，两栏都重读一遍。
      void browser.reload();
      void browsers[pane === "left" ? "right" : "left"].reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  useEffect(() => {
    setPicked((current) => (current.left.length === 0 ? current : { ...current, left: [] }));
    anchorRef.current.left = -1;
    // 兜底：正常换目录时 onNavigate 已经清过了，这里是为了别的路径也能收干净。
    setSelectMode(false);
    // 预览里可能是上一级的文件（已经不在这一批行里了），先清掉。
    setFocusEntry(null);
  }, [left.location]);

  useEffect(() => {
    setPicked((current) => (current.right.length === 0 ? current : { ...current, right: [] }));
    anchorRef.current.right = -1;
    setSelectMode(false);
  }, [right.location]);

  useEffect(() => {
    const roots = [leftList.current, rightList.current].filter(
      (node): node is HTMLDivElement => node !== null,
    );
    const onFocus = (event: FocusEvent) => {
      const node = event.target as HTMLElement | null;
      node?.scrollIntoView({ block: "nearest" });
      // 预览要跟着**焦点**走：行上有 `data-file-index`，用它反查是哪一条。
      const index = Number(node?.dataset.fileIndex ?? "-1");
      if (index < 0) return;
      const pane: PaneId = node?.closest("[data-pane='right']") ? "right" : "left";
      setFocusEntry(paneRef.current[pane][index] ?? null);
    };
    roots.forEach((root) => root.addEventListener("focusin", onFocus));
    return () => roots.forEach((root) => root.removeEventListener("focusin", onFocus));
  }, [dual, layout]);

  // 换目录 / 改名 / 新建之后，把焦点放到该放的那一行上。
  // 依赖只写「会改变焦点位置」的那几项（别把整个 active 对象放进来：它每次渲染都是新的，
  // 会导致每次渲染都跑一遍，把正在按排序按钮的焦点抢走）。
  //
  // `active.rowsToken` 是这份依赖里最容易被漏掉、也最要命的一项：换目录后新的一批文件是
  // **异步**回来的。只盯着 `location` 的话，effect 会在「还是上一级的行」时就跑完，焦点落在
  // 一行马上要被删掉的旧行上；等新行到位，那行被删 → 焦点掉回 body → 手柄下一次按方向键
  // 就从页面第一个按钮（最上面的显示模式）重新开始，用户得一路按下来。
  // 加上指纹后，行真的换了才会再跑一次，把焦点安顿到新目录的第一行。
  useEffect(() => {
    if (dialogOpen) return;
    const pending = active.pendingFocus;
    const list = listOf(activePane).current;
    if (pending && list) {
      const el = list.querySelector<HTMLElement>(`[data-file-name="${CSS.escape(pending)}"]`);
      if (el) {
        el.focus();
        active.clearPendingFocus();
        return;
      }
    }
    const current = document.activeElement as HTMLElement | null;
    // 焦点已经在这一栏里、或者在任何焦点池（工具栏 / 排序 / 面包屑）上，就别抢：
    // 用户正按着排序按钮，焦点被拉走会被当成「按键没反应」。
    // （列表重读把焦点删掉时 activeElement 会变回 body，body 不在任何池里，照样会走到下面。）
    if (current?.closest("[data-focus-zone]")) return;
    // 优先落进列表第一行（换目录后接着用方向键最顺）；空文件夹才退到面包屑。
    const firstRow = listOf(activePane).current?.querySelector<HTMLElement>(
      "[data-focusable]:not([disabled])",
    );
    if (firstRow) {
      firstRow.focus();
      return;
    }
    const pane = document.querySelector<HTMLElement>(`[data-pane="${activePane}"]`);
    pane?.querySelector<HTMLElement>("[data-focusable]:not([disabled])")?.focus();
  }, [activePane, dialogOpen, dual, layout, active.location, active.pendingFocus, active.rowsToken]);

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);

  useEffect(() => {
    if (rename) renameRef.current?.focus();
  }, [rename?.entry.path]);

  useEffect(() => {
    if (batch) batchRef.current?.focus();
  }, [batch?.items]);

  useEffect(() => {
    if (search) searchRef.current?.focus();
  }, [search?.id]);

  useEffect(() => {
    if (menu) document.querySelector<HTMLElement>(".file-menu [data-focusable]")?.focus();
  }, [menu]);

  useEffect(() => {
    if (editor) editorRef.current?.focus();
  }, [editor?.path]);

  useEffect(() => {
    if (trash) trashCancelRef.current?.focus();
  }, [trash]);

  useEffect(() => {
    if (props) document.querySelector<HTMLElement>(".file-props [data-focusable]")?.focus();
  }, [props]);

  useEffect(() => {
    if (placesDialog) document.querySelector<HTMLElement>(".file-places [data-focusable]")?.focus();
  }, [placesDialog]);

  useEffect(() => {
    if (conflict) document.querySelector<HTMLElement>(".file-conflict [data-focusable]")?.focus();
  }, [conflict]);

  // 手柄回调注册一次就够：里面全走 handlersRef / actionsRef 读最新的闭包，
  // 不然 rAF 里拿到的会是第一次渲染时的状态（老代码踩过这个坑）。
  const handlersRef = useRef({ back, openMenu, toggleSelect, dismissAll, switchPaneDirection, stageCopy, stageCut });
  handlersRef.current = { back, openMenu, toggleSelect, dismissAll, switchPaneDirection, stageCopy, stageCut };

  useEffect(() => {
    setFileActions({
      blocksTabs: () => actionsRef.current.dialogOpen || actionsRef.current.selectMode,
      dismiss: () => handlersRef.current.dismissAll(),
      openMenu: () => handlersRef.current.openMenu(),
      toggleSelect: () => handlersRef.current.toggleSelect(),
      // X / Y：**有选中项才接走**，没有就返回 false，让 App 落到老绑定
      // （X 进选择模式 / Y 开菜单）—— 不然多功能就只剩「选中之后」才走得到。
      copy: () => handlersRef.current.stageCopy(),
      cut: () => handlersRef.current.stageCut(),
      back: () => handlersRef.current.back(),
      switchPane: (dir) => handlersRef.current.switchPaneDirection(dir),
    });
    return () => setFileActions({});
  }, []);

  const sortLabel = (key: SortKey) =>
    key === "name"
      ? text().files.sortName
      : key === "size"
        ? text().files.sortSize
        : key === "time"
          ? text().files.sortTime
          : text().files.sortType;

  const hint =
    active.note ||
    (pickedNow.length > 0
      ? text().files.pickedHint(pickedNow.length)
      : selectMode
        ? text().files.selectModeHint
        : dual
          ? text().files.dualHint(activeLabel)
          : active.preview
            ? text().files.previewHint
            : text().files.browseHint);

  /**
   * 批量改名的**对照表**（画板 F4）：每一行「原名 → 新名 + 状态」。
   *
   * 冲突有两种：新名撞上目录里已有的东西，或者两条计划改成了同一个名字。
   * 判断必须在前端做 —— 后端的 `file_rename_many` 只负责安全落地，它拒了就整批停下，
   * 用户看到的是「失败」，而看不出来是**哪一行**跟谁撞了。
   */
  const batchRows = useMemo(() => {
    if (!batch) return [];
    const pairs = batchPlan(batch);
    // 自己占着的名字先腾出来：否则「这次不改名」的行会被自己判成冲突。
    const taken = new Set(entries.map((row) => row.name.toLowerCase()));
    for (const item of batch.items) taken.delete(item.name.toLowerCase());
    const rows: {
      from: string;
      name: string;
      to: string;
      clash: boolean;
      resolved: string;
    }[] = [];
    for (const pair of pairs) {
      const lower = pair.to.toLowerCase();
      const clash = taken.has(lower) || pair.to === pair.name;
      let resolved = pair.to;
      if (clash) {
        // 「自动编号」：`掌机_3.png` → `掌机_3 (2).png`，一直试到不撞为止。
        const [stem, ext] = splitName(pair.to);
        for (let index = 2; index < 100; index += 1) {
          const candidate = `${stem} (${index})${ext}`;
          if (!taken.has(candidate.toLowerCase())) {
            resolved = candidate;
            break;
          }
        }
      }
      taken.add(resolved.toLowerCase());
      rows.push({ from: pair.from, name: pair.name, to: pair.to, clash, resolved });
    }
    return rows;
  }, [batch, entries]);

  const batchClash = batchRows.filter((row) => row.clash);
  /** 按当前策略算出真正要发出去的那些对。 */
  const batchRunPairs = batchRows
    .filter((row) => row.to !== row.name)
    .flatMap((row) => {
      // 没冲突的行照改。
      if (!row.clash) return [{ from: row.from, to: row.to, victim: "" }];
      // 有冲突的按策略：跳过就不发出去；自动编号用不撞的名字；覆盖先删同名的旧文件。
      if (batchConflict === "skip") return [];
      return [
        {
          from: row.from,
          to: batchConflict === "number" ? row.resolved : row.to,
          // 「覆盖」要先把同名的旧文件删掉：`std::fs::rename` 在目标已存在时会直接失败，
          // 不删就永远改不过去。这一步是**不可逆**的，卡片上写明了。
          victim:
            batchConflict === "replace"
              ? (entries.find((entry) => entry.name.toLowerCase() === row.to.toLowerCase())?.path ??
                "")
              : "",
        },
      ];
    });
  const targets = menu ? targetsFor(menu, activePane) : [];

  /**
   * 底部操作条作用于**当前选中的那些项**（画板 K7 那条左边写的就是「已选 N 项 · 名字」）。
   *
   * 为什么不回退到「焦点那一项」：焦点不触发 React 重渲染，按 chip 的可用状态会停在上一帧，
   * 出现「按钮亮着但点了没反应」。选中是 state，状态和动作一定同步。
   */
  const barTargets = useMemo(
    () => entries.filter((row) => pickedNow.includes(row.path)),
    [entries, pickedNow],
  );
  const barNames = barTargets
    .slice(0, 2)
    .map((row) => row.name)
    .join("、");
  const barNote =
    barTargets.length > 0
      ? `${text().files.selectedCount(barTargets.length)}${
          barNames ? ` · ${barNames}${barTargets.length > 2 ? " …" : ""}` : ""
        }`
      : hint;

  /**
   * 剪切 / 复制：和 Y 菜单里那两颗按钮同一个动作（都只是装进剪贴板）。
   * 返回值给手柄绑定用：**没选中东西就是 false**（见 files/actions.ts 的说明）。
   */
  function stageSelection(mode: "copy" | "move"): void {
    if (barTargets.length === 0) return;
    if (mode === "copy") active.stageCopy(barTargets);
    else active.stageMove(barTargets);
  }

  function stageCopy(): boolean {
    if (barTargets.length === 0) return false;
    stageSelection("copy");
    return true;
  }

  function stageCut(): boolean {
    if (barTargets.length === 0) return false;
    stageSelection("move");
    return true;
  }

  /** 跳到这条结果所在的文件夹，并把它自己选上（比「打开」有用：先看清它在哪）。 */
  function jumpToHit(hit: SearchHit) {
    const parent = hit.path.slice(0, Math.max(0, hit.path.length - hit.name.length - 1));
    active.jump(parent || null, hit.name);
    setSearch(null);
  }

  function onDragStart(entry: FileEntry, pane: PaneId) {
    dragRef.current = targetsFor(entry, pane);
  }

  /**
   * 拖到文件夹上松手 = 移动（和资源管理器同一个盘上的行为一致）。
   * 目标文件夹里的同名冲突这里看不见（没读它的目录），所以直接用「保留两者」，
   * 后端会自己改名 —— 宁可多出「副本」，也不覆盖。
   */
  function onDrop(folder: FileEntry, pane: PaneId) {
    const items = dragRef.current;
    dragRef.current = [];
    if (items.length === 0) return;
    if (items.some((item) => item.path === folder.path)) return;
    void transferSelection(items, "move", folder.path, pane);
  }

  function switchPaneDirection(dir: -1 | 1): boolean {
    if (!dual || actionsRef.current.dialogOpen) return false;
    const next: PaneId = dir < 0 ? "left" : "right";
    setActivePane(next);
    const pane = document.querySelector<HTMLElement>(`[data-pane="${next}"]`);
    pane?.querySelector<HTMLElement>("[data-focusable]:not([disabled])")?.focus();
    return true;
  }



  return (
    <main className="page k7-page">
      {/* 头部（画板 K7）：面包屑在左，搜索 / 排序在右，一行 30dp。
          额外那几颗 30dp 小按钮是既有能力（视图切换 / 隐藏文件 / 软键盘 / 返回上级）——
          画板这一行只有两颗大按钮，但能力不能丢，收成同高的小按钮排在搜索左边。 */}
      <div className={view === "browse" ? "k7-head" : "k7-head is-task"}>
        {/* 视图开关（文件管理增强）：浏览 / 任务 / 任务中心。任务中心带角标显示还有几个在跑 ——
            掌机上「切回文件页看进度」这一步本身就是这次要消掉的痛点。 */}
        <div className="k7-view" data-focus-zone="files-view">
          {(
            [
              ["browse", text().tasks.tabBrowse, 0],
              ["tasks", text().tasks.tabTasks, 0],
              ["jobs", text().tasks.tabJobs, running.length],
            ] as [FileView, string, number][]
          ).map(([id, label, badge]) => (
            <button
              key={id}
              type="button"
              className={view === id ? "k7-view-btn is-current" : "k7-view-btn"}
              data-focusable
              aria-pressed={view === id}
              onClick={() => {
                playSfx("tab");
                setView(id);
                setTask(null);
              }}
            >
              {label}
              {badge > 0 && <span className="tnum">{badge}</span>}
            </button>
          ))}
        </div>
        {view === "browse" &&
          (!dual ? (
            <FileCrumbs browser={active} zone={activePane === "left" ? "files-list" : "files-target"} />
          ) : (
            <span className="k7-crumbs" />
          ))}
        <div className="k7-tools" data-focus-zone="files-tools">
          <button
            type="button"
            className={layout === "list" ? "k7-tool is-current" : "k7-tool"}
            data-focusable
            aria-label={text().files.list}
            aria-pressed={layout === "list"}
            onClick={() => {
              setLayout("list");
              try {
                localStorage.setItem(LAYOUT_KEY, "list");
              } catch {
                /* private mode */
              }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
              <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className={layout === "grid" ? "k7-tool is-current" : "k7-tool"}
            data-focusable
            aria-label={text().files.grid}
            aria-pressed={layout === "grid"}
            onClick={() => {
              setLayout("grid");
              try {
                localStorage.setItem(LAYOUT_KEY, "grid");
              } catch {
                /* private mode */
              }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
              <rect x="2" y="2" width="5.5" height="5.5" rx="1" fill="currentColor" />
              <rect x="10.5" y="2" width="5.5" height="5.5" rx="1" fill="currentColor" />
              <rect x="2" y="10.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
              <rect x="10.5" y="10.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className={dual ? "k7-tool is-current" : "k7-tool"}
            data-focusable
            aria-label={text().files.dual}
            aria-pressed={dual}
            onClick={() => {
              const next = !dual;
              setDual(next);
              if (!next) setActivePane("left");
              try {
                localStorage.setItem(DUAL_KEY, next ? "1" : "0");
              } catch {
                /* private mode */
              }
            }}
          >
            <svg width="17" height="16" viewBox="0 0 20 18" aria-hidden>
              <rect x="1" y="3" width="8" height="12" rx="1.5" fill="currentColor" />
              <rect x="11" y="3" width="8" height="12" rx="1.5" fill="currentColor" opacity="0.45" />
            </svg>
          </button>

          {/* 预览开关（画板 F2 右上那颗「预览 开」）。放在这儿而不是页头最左：
              它是浏览视图的显示选项，和「网格 / 双栏」是同一类东西。 */}
          <button
            type="button"
            className={preview ? "k7-tool is-current" : "k7-tool"}
            data-focusable
            disabled={dual}
            aria-pressed={preview}
            aria-label={text().tasks.previewToggle}
            title={dual ? text().tasks.previewToggle : undefined}
            onClick={() => {
              const next = !preview;
              setPreview(next);
              try {
                localStorage.setItem(PREVIEW_KEY, next ? "1" : "0");
              } catch {
                /* private mode */
              }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
              <rect
                x="1.5"
                y="3"
                width="10"
                height="12"
                rx="1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <rect x="13" y="3" width="3.5" height="12" rx="1.2" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className={showHidden ? "k7-tool is-current" : "k7-tool"}
            data-focusable
            aria-pressed={showHidden}
            aria-label={showHidden ? text().files.hideHidden : text().files.showHidden}
            onClick={toggleHidden}
          >
            <EyeIcon off={!showHidden} />
          </button>
          {/* 掌机上打字：与其让用户用手柄一格一格挪虚拟键盘，不如把系统那把叫出来。 */}
          <button
            type="button"
            className="k7-tool"
            data-focusable
            aria-label={text().files.keyboard}
            title={text().files.keyboardHint}
            onClick={() =>
              void showSoftKeyboard().then((problem) => {
                if (problem) active.setNote(problem);
              })
            }
          >
            <KeyboardIcon />
          </button>
          <button
            type="button"
            className="k7-tool"
            data-focusable
            disabled={active.location == null}
            aria-label={text().files.up}
            onClick={() => void active.up()}
          >
            <UpIcon />
          </button>
          {/* 「位置」在单栏时是左边那一栏（画板 K7），只有双栏把它顶掉时才需要这颗按钮 */}
          {dual && (
            <button type="button" className="k7-tool" data-focusable onClick={() => void openPlaces()}>
              {text().files.places}
            </button>
          )}
          <button
            type="button"
            className="k7-search"
            data-focusable
            disabled={active.location == null}
            onClick={openSearch}
          >
            <SearchIcon />
            {text().files.search}
          </button>
          <button
            type="button"
            className="k7-sort"
            data-focusable
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((open) => !open)}
          >
            <SortIcon />
            {text().files.sortBy}
          </button>
        </div>
      </div>
      {/* 四个排序键 + 升降序收在「排序」按钮下面这一行（画板头部只有一颗按钮） */}
      {sortOpen && (
        <div className="k7-sort-row" data-focus-zone="files-sort" role="group" aria-label={text().files.sortBy}>
          {(["name", "size", "time", "type"] as SortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={active.sortKey === key ? "k7-sort-key is-current" : "k7-sort-key"}
              data-focusable
              aria-pressed={active.sortKey === key}
              aria-label={sortLabel(key)}
              onClick={() => active.chooseSort(key)}
            >
              {sortLabel(key)}
              {active.sortKey === key ? (active.sortDir === "asc" ? " ↑" : " ↓") : ""}
            </button>
          ))}
        </div>
      )}
      {/* 任务视图（文件管理增强）：和浏览视图共用页头与提示条，只有中间这块换掉。
          左栏「位置」在这里没有意义，所以整个 k7-body 都换成任务区。 */}
      {view === "tasks" && (
        <div className="k7-body">
          <div className="k7-task-view">
            {task ? (
              ctx ? (
                <TaskWizard
                  task={task}
                  ctx={ctx}
                  backRef={wizardBack}
                  onClose={() => setTask(null)}
                  onFinished={reloadBoth}
                />
              ) : (
                <p className="ft-note-body">{text().tasks.scanning}</p>
              )
            ) : (
              <TaskGrid
                runtime={runtime}
                onOpen={(next) => {
                  // 「最近传输」不走向导，直接跳到任务中心。
                  if (next.jump === "jobs") setView("jobs");
                  else setTask(next);
                }}
              />
            )}
          </div>
        </div>
      )}

      {view === "jobs" && (
        <div className="k7-body">
          <div className="k7-task-view">
            <JobsPanel onCancel={cancelJob} />
          </div>
        </div>
      )}

      {view === "browse" && (
      <div className="k7-body">
        {/* 左栏「位置」：单栏时的常驻一栏（画板实测 200×554，顶边与表头同起于 98） */}
        {!dual && (
          <aside className="k7-places" aria-label={text().files.places}>
            <p className="k7-places-title">{text().files.places}</p>
            {places.busy ? (
              <p className="k7-places-note">{text().files.propsReading}</p>
            ) : places.error ? (
              <p className="k7-places-note">{places.error}</p>
            ) : (
              <div className="k7-places-list" data-focus-zone="files-places">
                {places.rows.map((row) => {
                  const here = !!active.location && samePath(row.path, active.location);
                  return (
                    <button
                      key={row.path}
                      type="button"
                      className={here ? "k7-place is-current" : "k7-place"}
                      data-focusable
                      aria-current={here ? "true" : undefined}
                      onClick={() => active.jump(row.path)}
                    >
                      <FolderIcon />
                      <span className="k7-place-name">{row.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>
        )}
        <div className="k7-main">
          {/* 单栏 + 预览打开时：文件表与预览面板并排（画板 F2 的 556 + 424）。
              双栏时不显示预览 —— 两栏本来就吃满宽度，再挤一列预览每栏只剩 300dp。 */}
          <div className={dual ? "k7-panes" : preview ? "k7-split" : "k7-main-single"}>
          <FilePane
            browser={left}
            pane="left"
            zone="files-list"
            active={activePane === "left"}
            dual={dual}
            layout={layout}
            sortKey={left.sortKey}
            picked={picked.left}
            sizes={left.dirSizes}
            selectMode={selectMode}
            firstRef={leftFirst}
            listRef={leftList}
            onActivatePane={() => setActivePane("left")}
            onPick={(index, options) => pick("left", index, options)}
            onOpen={(entry) => openEntry(entry, "left")}
            onMenu={(entry) => {
              setActivePane("left");
              setMenu(entry);
            }}
            onDragStart={(entry) => onDragStart(entry, "left")}
            onDrop={(folder) => onDrop(folder, "left")}
          />
          {dual && (
            <FilePane
              browser={right}
              pane="right"
              zone="files-target"
              active={activePane === "right"}
              dual={dual}
              layout={layout}
              sortKey={right.sortKey}
              picked={picked.right}
              sizes={right.dirSizes}
              selectMode={selectMode}
              firstRef={rightFirst}
              listRef={rightList}
              onActivatePane={() => setActivePane("right")}
              onPick={(index, options) => pick("right", index, options)}
              onOpen={(entry) => openEntry(entry, "right")}
              onMenu={(entry) => {
                setActivePane("right");
                setMenu(entry);
              }}
              onDragStart={(entry) => onDragStart(entry, "right")}
              onDrop={(folder) => onDrop(folder, "right")}
            />
          )}
          {!dual && preview && (
            <PreviewPanel
              entry={focusEntry}
              size={focusEntry ? left.dirSizes[focusEntry.path] : undefined}
              onOpen={(entry) => void openEntry(entry, activePane)}
              onDelete={(entry) => setTrash([entry])}
            />
          )}
          </div>

          {running.length > 0 && (
            <section className="k7-progress" data-focus-zone="files-progress" aria-live="polite">
              {running.map((job) => {
                const scanning = job.phase === "scan";
                const percent =
                  job.totalBytes > 0 ? Math.min(100, Math.round((job.bytes / job.totalBytes) * 100)) : 0;
                return (
                  <div key={job.id} className="k7-progress-row">
                    <span className="k7-progress-name">{job.name || text().files.folder}</span>
                    <span className="k7-progress-bar" aria-hidden>
                      <span className="k7-progress-fill" style={{ width: `${scanning ? 0 : percent}%` }} />
                    </span>
                    <span className="k7-progress-meta">
                      {scanning
                        ? text().files.transferScan
                        : text().files.transferMeta(
                            job.itemIndex + 1,
                            job.itemTotal,
                            formatBytes(job.bytes),
                            formatBytes(job.totalBytes),
                          )}
                    </span>
                    {!scanning && job.rate > 0 && (
                      <span className="k7-progress-meta">
                        {text().files.transferRate(formatBytes(job.rate), formatEta(job.eta))}
                      </span>
                    )}
                    <button
                      type="button"
                      className="library-tool"
                      data-focusable
                      onClick={() => void active.cancel(job.id)}
                    >
                      {text().files.transferCancel}
                    </button>
                  </div>
                );
              })}
            </section>
          )}


          {/* 底部操作条（画板 K7：左「已选 N 项 · 名字」，右边一排能按的 chip）。
              动作全部作用于**当前选中项**：没选东西时复制 / 移动 / 重命名 / 删除是灰的，
              新建 / 粘贴 / 全选一直可用。

              按键角标（画板 K7 画了 X 复制 / Y 剪切 / ☰ 粘贴 / 长按 A 重命名 / 长按 B 删除 /
              LB 新建文件夹）：**只画真绑上了的**，而且只画在当前真的能用的时候 ——
              `CHIP_KEYS` 是这一处唯一的按键来源，改绑定就改它，角标不会说谎。
              没做的四条与理由见 `CHIP_KEYS` 上面那段注释。 */}
          <div className="k7-bar" data-focus-zone="files-actions">
            <p className="k7-bar-note">{barNote}</p>
            <button
              type="button"
              className="k7-chip"
              data-focusable
              disabled={barTargets.length === 0}
              onClick={() => stageSelection("copy")}
            >
              <KeyBadge label={CHIP_KEYS.copy} />
              {text().files.copy}
            </button>
            <button
              type="button"
              className="k7-chip"
              data-focusable
              disabled={barTargets.length === 0}
              onClick={() => stageSelection("move")}
            >
              <KeyBadge label={CHIP_KEYS.cut} />
              {text().files.move}
            </button>
            <button
              type="button"
              className="k7-chip"
              data-focusable
              disabled={(active.clip?.items.length ?? 0) === 0 || active.location == null}
              onClick={() => void pasteInto(activePane, active.location)}
            >
              {text().files.paste}
              {active.clip ? ` (${active.clip.items.length})` : ""}
            </button>
            <button
              type="button"
              className="k7-chip"
              data-focusable
              disabled={barTargets.length !== 1}
              onClick={() => {
                setFormError("");
                setRename({ entry: barTargets[0], draft: barTargets[0].name, pane: activePane });
              }}
            >
              {text().files.rename}
            </button>
            <button
              type="button"
              className="k7-chip"
              data-focusable
              disabled={barTargets.length === 0}
              onClick={() => setTrash(barTargets)}
            >
              {text().delete}
            </button>
            <button
              type="button"
              className="k7-chip"
              data-focusable
              disabled={barTargets.length !== 1}
              onClick={() => {
                const spot = barTargets[0];
                if (spot) void openPropertiesFor(spot, activePane);
              }}
            >
              {text().files.properties}
            </button>
            <button
              type="button"
              className="k7-chip"
              data-focusable
              disabled={active.location == null}
              onClick={() => {
                setDraft("");
                setFormError("");
                setNaming("dir");
              }}
            >
              {text().files.newFolder}
            </button>
            <button
              type="button"
              className="k7-chip"
              data-focusable
              disabled={active.location == null}
              onClick={() => {
                setDraft("");
                setFormError("");
                setNaming("file");
              }}
            >
              {text().files.newFile}
            </button>
            {/* 全选 / 取消全选是一颗按钮：已选就清空，没选就全选（和旧工具栏一个口径） */}
            <button
              type="button"
              className="k7-chip"
              data-focusable
              disabled={entries.length === 0}
              onClick={() => (pickedNow.length > 0 ? dropSelection(activePane) : selectAll(activePane))}
            >
              {pickedNow.length > 0 ? text().files.clearSelection : text().files.selectAll}
            </button>
          </div>
        </div>
      </div>
      )}

      {menu && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setMenu(null)}
          />
          <div className="group-dialog-panel group-create-panel file-menu" role="dialog" aria-label={menu.name}>
            <h2>
              {targets.length > 1 ? text().files.selectedCount(targets.length) : menu.name}
              {dual ? ` · ${activeLabel}` : ""}
            </h2>
            <div className="library-tools file-menu-actions">
              {targets.length === 1 && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => openEntry(targets[0], activePane)}
                >
                  {text().open}
                </button>
              )}
              {targets.length === 1 && targets[0].kind === "file" && targets[0].editable && (
                <button type="button" className="library-tool" data-focusable onClick={() => void edit(targets[0])}>
                  {text().edit}
                </button>
              )}
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  active.stageCopy(targets);
                  setMenu(null);
                }}
              >
                {text().files.copy}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  active.stageMove(targets);
                  setMenu(null);
                }}
              >
                {text().files.move}
              </button>
              {(active.clip?.items.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    setMenu(null);
                    void pasteInto(activePane, active.location);
                  }}
                >
                  {text().files.paste}
                </button>
              )}
              {dual && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  disabled={other.location == null}
                  onClick={() => {
                    setMenu(null);
                    void transferSelection(targets, "copy", other.location ?? "", activePane, other.entries);
                  }}
                >
                  {text().files.copyToOther(otherLabel)}
                </button>
              )}
              {dual && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  disabled={other.location == null}
                  onClick={() => {
                    setMenu(null);
                    void transferSelection(targets, "move", other.location ?? "", activePane, other.entries);
                  }}
                >
                  {text().files.moveToOther(otherLabel)}
                </button>
              )}
              {targets.length === 1 && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    setFormError("");
                    setRename({ entry: targets[0], draft: targets[0].name, pane: activePane });
                    setMenu(null);
                  }}
                >
                  {text().files.rename}
                </button>
              )}
              {targets.length > 1 && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    setFormError("");
                    setBatch({
                      items: targets,
                      mode: "original",
                      base: "",
                      start: "1",
                      find: "",
                      replace: "",
                    });
                    setMenu(null);
                  }}
                >
                  {text().files.batchRename}
                </button>
              )}
              {targets.length === 1 && targets[0].kind === "file" && isArchiveName(targets[0].name) && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    const entry = targets[0];
                    setMenu(null);
                    void active.extract(entry);
                  }}
                >
                  {text().files.extract}
                </button>
              )}
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  const items = targets;
                  setMenu(null);
                  // 不弹名字输入：默认用当前目录名（和资源管理器一个习惯），重名自动加序号。
                  void active.compress(items);
                }}
              >
                {text().files.compress}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  setTrash(targets);
                  setMenu(null);
                }}
              >
                {text().delete}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => void openProperties()}
              >
                {text().files.properties}
              </button>
              {/* 两个动作分开写死：全选永远全选，取消永远取消。 */}
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  selectAll(activePane);
                  setMenu(null);
                }}
              >
                {text().files.selectAll}
              </button>
              {pickedNow.length > 0 && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    dropSelection(activePane);
                    setMenu(null);
                  }}
                >
                  {text().files.clearSelection}
                </button>
              )}
            </div>
          </div>
        </div>
      )}


      {rename && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => {
              setRename(null);
              setFormError("");
            }}
          />
          <form
            className="group-dialog-panel group-create-panel"
            role="dialog"
            aria-label={text().files.renameTitle(rename.entry.name)}
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <h2>{text().files.renameTitle(rename.entry.name)}</h2>
            <input
              ref={renameRef}
              className="group-name-input"
              data-focusable
              value={rename.draft}
              maxLength={120}
              placeholder={text().files.namePlaceholder}
              onChange={(event) => setRename({ ...rename, draft: event.target.value })}
            />
            <p className="group-empty">{formError || text().files.renameHint}</p>
            <div className="library-tools">
              <button type="submit" className="library-tool" data-focusable>
                {text().save}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  setRename(null);
                  setFormError("");
                }}
              >
                {text().cancel}
              </button>
            </div>
          </form>
        </div>
      )}



      {batch && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => {
              setBatch(null);
              setFormError("");
            }}
          />
          <form
            className="group-dialog-panel file-batch-panel"
            role="dialog"
            aria-label={text().files.batchRename}
            onSubmit={(event) => {
              event.preventDefault();
              void submitBatch();
            }}
          >
            <h2>
              {text().files.batchRename} · {text().files.selectedCount(batch.items.length)}
            </h2>
            <div className="file-batch-modes" data-focus-zone="files-batch-modes">
              {(["original", "number", "replace"] as BatchMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={batch.mode === mode ? "library-tool is-current" : "library-tool"}
                  data-focusable
                  aria-pressed={batch.mode === mode}
                  onClick={() => setBatch({ ...batch, mode })}
                >
                  {mode === "original"
                    ? text().files.batchModeOriginal
                    : mode === "number"
                      ? text().files.batchModeNumber
                      : text().files.batchModeReplace}
                </button>
              ))}
            </div>
            {batch.mode !== "original" && (
              <div className="file-batch-fields">
                {batch.mode === "number" ? (
                  <>
                    <label className="file-batch-field">
                      <span>{text().files.batchBase}</span>
                      <input
                        ref={batchRef}
                        className="group-name-input"
                        data-focusable
                        value={batch.base}
                        maxLength={60}
                        placeholder={text().files.batchBaseHint}
                        onChange={(event) => setBatch({ ...batch, base: event.target.value })}
                      />
                    </label>
                    <label className="file-batch-field">
                      <span>{text().files.batchStart}</span>
                      <input
                        className="group-name-input"
                        data-focusable
                        inputMode="numeric"
                        value={batch.start}
                        maxLength={4}
                        onChange={(event) => setBatch({ ...batch, start: event.target.value })}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="file-batch-field">
                      <span>{text().files.batchFind}</span>
                      <input
                        ref={batchRef}
                        className="group-name-input"
                        data-focusable
                        value={batch.find}
                        maxLength={60}
                        onChange={(event) => setBatch({ ...batch, find: event.target.value })}
                      />
                    </label>
                    <label className="file-batch-field">
                      <span>{text().files.batchReplace}</span>
                      <input
                        className="group-name-input"
                        data-focusable
                        value={batch.replace}
                        maxLength={60}
                        onChange={(event) => setBatch({ ...batch, replace: event.target.value })}
                      />
                    </label>
                  </>
                )}
              </div>
            )}
            <p className="file-batch-preview-title">{text().files.batchPreview}</p>
            {/* 对照表（画板 F4）：表头 40、行高 34、**固定高度靠滚动**；
                底部那张卡固定在下方，行数再多也不会把「执行」挤出可视区。 */}
            <div className="k7-renames">
              <div className="k7-rename-head">
                <span>{text().tasks.renameColumnFrom}</span>
                <span>{text().tasks.renameColumnTo}</span>
                <span>{text().tasks.renameColumnState}</span>
              </div>
              <ul className="k7-rename-list">
                {batchRows.map((row) => (
                  <li
                    key={row.from}
                    className={`k7-rename-row${row.clash ? " is-conflict" : row.to === row.name ? " is-same" : ""}`}
                  >
                    <span className="k7-rename-from">{row.name}</span>
                    <span className="k7-rename-to">{row.to}</span>
                    <span className="k7-rename-state">
                      {row.clash
                        ? text().tasks.renameConflictChip
                        : row.to === row.name
                          ? text().tasks.renameUnchanged
                          : text().tasks.renameOk}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {batchClash.length > 0 ? (
              <div className="k7-rename-foot is-conflict">
                <h3>{text().tasks.renameConflictCard(batchClash[0].to)}</h3>
                <p className="ft-field-hint">
                  {text().tasks.renameCount(batchRunPairs.length, batchClash.length)}
                </p>
                <div className="ft-chips">
                  {(
                    [
                      ["skip", text().tasks.conflictSkip],
                      ["number", text().tasks.conflictKeep],
                      ["replace", text().tasks.conflictReplace],
                    ] as ["skip" | "number" | "replace", string][]
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={batchConflict === value ? "ft-chip is-on" : "ft-chip"}
                      data-focusable
                      aria-pressed={batchConflict === value}
                      onClick={() => setBatchConflict(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="ft-field-hint">
                  {batchConflict === "replace"
                    ? text().tasks.optDeleteWarning
                    : text().tasks.renameApplyAllHint}
                </p>
              </div>
            ) : (
              <div className="k7-rename-foot">
                <h3>{text().tasks.renameCount(batchRunPairs.length, 0)}</h3>
              </div>
            )}
            <p className="group-empty">{formError || text().files.batchKeyboard}</p>
            <div className="library-tools">
              <button
                type="submit"
                className="library-tool"
                data-focusable
                disabled={batchRunPairs.length === 0}
              >
                {text().tasks.renameRun}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  setBatch(null);
                  setFormError("");
                }}
              >
                {text().cancel}
              </button>
            </div>
          </form>
        </div>
      )}

      {props && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setProps(null)}
          />
          <div className="group-dialog-panel file-props" role="dialog" aria-label={text().files.properties}>
            <h2>{props.name}</h2>
            {props.busy ? (
              <p className="group-empty">{text().files.propsReading}</p>
            ) : props.info ? (
              <dl className="file-props-list">
                <div>
                  <dt>{text().files.propPath}</dt>
                  <dd>{props.info.path}</dd>
                </div>
                <div>
                  <dt>{text().files.propKind}</dt>
                  <dd>{props.info.kind === "dir" ? text().files.folder : text().files.file}</dd>
                </div>
                <div>
                  <dt>{text().files.propSize}</dt>
                  <dd>
                    {formatBytes(props.info.bytes)}
                    {props.info.kind === "dir" && !props.info.sizeComplete
                      ? ` ${text().files.propPartial}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>{text().files.propModified}</dt>
                  <dd>{formatTime(props.info.modified)}</dd>
                </div>
                <div>
                  <dt>{text().files.propCreated}</dt>
                  <dd>{formatTime(props.info.created)}</dd>
                </div>
                <div>
                  <dt>{text().files.propExtension}</dt>
                  <dd>{props.info.extension || "—"}</dd>
                </div>
                <div>
                  <dt>{text().files.propAttrs}</dt>
                  <dd>
                    {[
                      props.info.readonly ? text().files.attrReadonly : "",
                      props.info.hidden ? text().files.attrHidden : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || "—"}
                  </dd>
                </div>
                <div>
                  <dt>{text().files.propWritable}</dt>
                  <dd>{props.info.writable ? text().files.propYes : text().files.propNo}</dd>
                </div>
              </dl>
            ) : null}
            <p className="preview-note">
              {props.error ||
                (props.info && !props.info.writable ? text().files.hintDenied : "") ||
                (props.info?.protected ? text().files.hintProtected : "") ||
                (props.info?.writeReason === "busy" ? text().files.hintBusy : "")}
            </p>
            <div className="library-tools">
              <button type="button" className="library-tool" data-focusable onClick={() => setProps(null)}>
                {text().close}
              </button>
            </div>
          </div>
        </div>
      )}



      {search && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => {
              if (search.busy) void active.cancel(search.id);
              setSearch(null);
            }}
          />
          <form
            className="group-dialog-panel file-search-panel"
            role="dialog"
            aria-label={text().files.searchTitle(activeLabel)}
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <h2>
              {text().files.searchTitle(activeLabel)} · {active.pathLabel}
            </h2>
            <input
              ref={searchRef}
              className="group-name-input"
              data-focusable
              value={search.query}
              maxLength={60}
              placeholder={text().files.searchPlaceholder}
              onChange={(event) => setSearch({ ...search, query: event.target.value })}
            />
            <p className="preview-note">
              {search.error || (search.busy ? text().files.searching : text().files.searchKeyboard)}
            </p>
            {search.hits !== null &&
              (search.hits.length === 0 ? (
                <p className="group-empty">{text().files.searchEmpty(search.query)}</p>
              ) : (
                <div className="file-search-hits" data-focus-zone="files-search-hits">
                  {search.hits.map((hit) => (
                    <button
                      key={hit.path}
                      type="button"
                      className="file-search-hit"
                      data-focusable
                      onClick={() => jumpToHit(hit)}
                    >
                      <span className="file-search-name">
                        {hit.kind === "dir" ? text().files.dirMark : text().files.fileMark} {hit.name}
                      </span>
                      <span className="file-search-dir">{hit.relative || active.pathLabel}</span>
                    </button>
                  ))}
                </div>
              ))}
            {search.hits !== null && search.hits.length >= 300 && (
              <p className="preview-note">{text().files.searchCap}</p>
            )}
            <div className="library-tools">
              <button type="submit" className="library-tool" data-focusable disabled={search.busy}>
                {text().files.searchStart}
              </button>
              {search.busy && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => void active.cancel(search.id)}
                >
                  {text().files.transferCancel}
                </button>
              )}
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  if (search.busy) void active.cancel(search.id);
                  setSearch(null);
                }}
              >
                {text().close}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 位置弹窗只在双栏里出现：单栏时那一栏就在左边（画板 K7）。
          这里读的是 placesDialog（弹窗自己的取数状态），别错写成左边那栏的 places。 */}
      {placesDialog && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setPlacesDialog(null)}
          />
          <div className="group-dialog-panel file-places" role="dialog" aria-label={text().files.placesTitle}>
            <h2>{text().files.placesTitle}</h2>
            {placesDialog.busy ? (
              <p className="group-empty">{text().files.propsReading}</p>
            ) : placesDialog.error ? (
              <p className="group-empty">{placesDialog.error}</p>
            ) : (
              <div className="file-places-list" data-focus-zone="files-places-list">
                {placesDialog.rows.map((row) => (
                  <button
                    key={row.path}
                    type="button"
                    className="file-row"
                    data-focusable
                    onClick={() => {
                      active.jump(row.path);
                      setPlacesDialog(null);
                    }}
                  >
                    <span className="file-mark is-dir" aria-hidden>
                      {text().files.dirMark}
                    </span>
                    <span className="file-name">{row.name}</span>
                    <span className="file-size">{row.path}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="library-tools">
              <button type="button" className="library-tool" data-focusable onClick={() => setPlacesDialog(null)}>
                {text().close}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setConfirm(null)}
          />
          <div className="group-dialog-panel group-create-panel file-conflict" role="dialog" aria-label={text().tasks.confirmTitle}>
            <ConfirmSummary
              showConflict={false}
              summary={{
                count: confirm.count,
                totalBytes: confirm.bytes,
                etaSec: confirm.bytes / (45 * 1024 * 1024),
                conflictPolicy: "keepBoth",
                notes: [text().tasks.sumEstimate],
              }}
            />
            <div className="library-tools file-menu-actions">
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  const pending = confirm;
                  setConfirm(null);
                  void runTransfer(pending.items, pending.mode, pending.destDir, pending.pane, "keep");
                }}
              >
                {text().tasks.start}
              </button>
              <button type="button" className="library-tool" data-focusable onClick={() => setConfirm(null)}>
                {text().cancel}
              </button>
            </div>
          </div>
        </div>
      )}

      {conflict && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setConflict(null)}
          />
          <div className="group-dialog-panel group-create-panel file-conflict" role="dialog" aria-label={text().files.conflictTitle}>
            <h2>{text().files.conflictTitle}</h2>
            <p className="group-empty">{text().files.conflictBody(conflict.count)}</p>
            <div className="library-tools file-menu-actions">
              {(["replace", "skip", "keep"] as Conflict[]).map((policy) => (
                <button
                  key={policy}
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    const pending = conflict;
                    // 勾了「对后续所有冲突使用此选择」就把它记下来：后面的同名冲突
                    // 直接按这个策略办，不再弹层（改造包 §5.2）。
                    if (conflictApplyAll) conflictPolicy.current = policy;
                    setConflict(null);
                    void runTransfer(pending.items, pending.mode, pending.destDir, pending.pane, policy);
                  }}
                >
                  {policy === "replace"
                    ? text().files.conflictReplace
                    : policy === "skip"
                      ? text().files.conflictSkip
                      : text().files.conflictKeep}
                </button>
              ))}
              <button type="button" className="library-tool" data-focusable onClick={() => setConflict(null)}>
                {text().cancel}
              </button>
            </div>
            <label className="k7-apply-all">
              <input
                type="checkbox"
                checked={conflictApplyAll}
                data-focusable
                onChange={(event) => setConflictApplyAll(event.target.checked)}
              />
              {text().tasks.renameApplyAll}
            </label>
            <p className="ft-field-hint">{text().tasks.renameApplyAllHint}</p>
          </div>
        </div>
      )}


      {naming && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => {
              setNaming(null);
              setDraft("");
              setFormError("");
            }}
          />
          <form
            className="group-dialog-panel group-create-panel"
            role="dialog"
            aria-label={naming === "dir" ? text().files.newFolder : text().files.newFile}
            onSubmit={(event) => {
              event.preventDefault();
              void submitName();
            }}
          >
            <h2>{naming === "dir" ? text().files.newFolder : text().files.newFile}</h2>
            <input
              ref={nameRef}
              className="group-name-input"
              data-focusable
              value={draft}
              placeholder={text().files.namePlaceholder}
              maxLength={120}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="group-empty">{formError || text().files.createHint}</p>
            <div className="library-tools">
              <button type="submit" className="library-tool" data-focusable>
                {text().create}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  setNaming(null);
                  setDraft("");
                  setFormError("");
                }}
              >
                {text().cancel}
              </button>
            </div>
          </form>
        </div>
      )}

      {editor && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setEditor(null)}
          />
          <div
            className="group-dialog-panel file-editor-panel"
            role="dialog"
            aria-label={text().files.editTitle(editor.name)}
          >
            <h2>{editor.name}</h2>
            <textarea
              ref={editorRef}
              className="file-editor"
              data-focusable
              value={editor.text}
              onChange={(event) => {
                const pos = event.target.selectionStart ?? event.target.value.length;
                const body = event.target.value;
                setEditor((current) => (current ? { ...current, text: body } : current));
                requestAnimationFrame(() => editorRef.current?.setSelectionRange(pos, pos));
              }}
            />
            <p className="group-empty">{text().files.editorHint}</p>
            <div className="library-tools">
              <button
                ref={saveRef}
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  void active
                    .writeText(editor.path, editor.text)
                    .then(() => setEditor(null))
                    .catch((err: unknown) => setNote(describeError(toFileError(err))));
                }}
              >
                {text().save}
              </button>
              <button type="button" className="library-tool" data-focusable onClick={() => setEditor(null)}>
                {text().close}
              </button>
            </div>
          </div>
        </div>
      )}

      {trash && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setTrash(null)}
          />
          <div className="group-dialog-panel group-create-panel" role="dialog" aria-label={text().files.deleteTitle}>
            <h2>
              {trash.length === 1
                ? text().files.deleteOne(trash[0].name)
                : text().files.deleteMany(trash.length)}
            </h2>
            <p className="group-empty">{text().files.deleteBody}</p>
            <div className="library-tools">
              <button
                ref={trashCancelRef}
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => setTrash(null)}
              >
                {text().cancel}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  const targetsToDelete = trash;
                  setTrash(null);
                  // 彻底删除：跳过回收站，删了就找不回来。
                  void active.remove(targetsToDelete, true);
                  if (activePane === "left") void right.reload();
                  else void left.reload();
                }}
              >
                {text().files.deletePermanent}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  const targetsToDelete = trash;
                  setTrash(null);
                  void active.remove(targetsToDelete);
                  if (activePane === "left") void right.reload();
                  else void left.reload();
                }}
              >
                {text().files.deleteRecycle}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

