import { useCallback, useEffect, useRef, useState } from "react";
import { playSfx } from "../audio/sfx";
import { setFileActions } from "../files/actions";
import { FilePane, formatBytes, formatTime, type FileLayout } from "../files/FilePane";
import {
  jobId,
  toFileError,
  useFileBrowser,
  type Conflict,
  type FileEntry,
  type FileErrorInfo,
  type FileProperties,
  type SearchHit,
  type SortKey,
  type TransferItem,
} from "../files/useFileBrowser";
import { forgetJob, useFileJobs } from "../files/useFileJobs";
import { text } from "../i18n";

type PaneId = "left" | "right";
type Naming = "dir" | "file" | null;
type EditorState = { path: string; name: string; text: string };
type BatchMode = "original" | "number" | "replace";

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

export function FilesPage() {
  const [dual, setDual] = useState(loadDual);
  const [activePane, setActivePane] = useState<PaneId>("left");
  const [layout, setLayout] = useState<FileLayout>(loadLayout);
  const [picked, setPicked] = useState<Record<PaneId, string[]>>({ left: [], right: [] });
  const [selectMode, setSelectMode] = useState(false);

  const [menu, setMenu] = useState<FileEntry | null>(null);
  const [naming, setNaming] = useState<Naming>(null);
  const [draft, setDraft] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [trash, setTrash] = useState<FileEntry[] | null>(null);
  const [rename, setRename] = useState<{ entry: FileEntry; draft: string; pane: PaneId } | null>(null);
  const [batch, setBatch] = useState<BatchForm | null>(null);
  const [props, setProps] = useState<PropsState | null>(null);
  const [search, setSearch] = useState<SearchForm | null>(null);
  const [places, setPlaces] = useState<PlacesState | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
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

  const left = useFileBrowser({ cacheKey: "left", onNavigate: () => dropSelection("left") });
  const right = useFileBrowser({ cacheKey: "right", onNavigate: () => dropSelection("right") });

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
    places !== null ||
    conflict !== null;

  const jobs = useFileJobs();
  const running = jobs.filter((job) => job.phase === "scan" || job.phase === "run");

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

  const setPickedFor = useCallback((pane: PaneId, next: string[]) => {
    setPicked((current) => ({ ...current, [pane]: next }));
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

  /** 焦点走到哪就选到哪：手柄没有 Shift，这就是「区间选择」。 */
  const focusRowFor = useCallback(
    (pane: PaneId, index: number) => {
      if (!selectMode) return;
      const entry = paneRef.current[pane][index];
      if (!entry) return;
      setPicked((current) =>
        current[pane].includes(entry.path) ? current : { ...current, [pane]: [...current[pane], entry.path] },
      );
    },
    [selectMode],
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
      setConflict({ items, mode, destDir, pane, count: collisions });
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
    if (collisions > 0) {
      setConflict({ items, mode: browser.clip?.mode ?? "copy", destDir, pane, count: collisions });
      return;
    }
    const id = await browser.paste("keep");
    if (id) jobPanes.current[id] = pane;
  }

  function openEntry(entry: FileEntry, pane: PaneId) {
    setMenu(null);
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

  /** X：进/出选择模式，或在选择模式里切换当前项的选中。 */
  function toggleSelect() {
    const spot = focusedRow();
    if (!spot) return false;
    setActivePane(spot.pane);
    if (!selectMode) {
      // 第一次按 = 进选择模式并选中当前项：手柄上「进模式」和「选第一项」是同一个动作，
      // 拆成两次按键对玩家是纯负担。
      setSelectMode(true);
      setPickedFor(spot.pane, [paneRef.current[spot.pane][spot.index].path]);
      anchorRef.current[spot.pane] = spot.index;
      return true;
    }
    pick(spot.pane, spot.index);
    return true;
  }

  function exitSelection() {
    setSelectMode(false);
    setPicked({ left: [], right: [] });
  }

  function back(): boolean {
    if (conflict) {
      setConflict(null);
      return true;
    }
    if (places) {
      setPlaces(null);
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
    setPlaces(null);
    setConflict(null);
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
    const plan = batchPlan(batch);
    if (plan.length === 0) {
      setFormError(text().files.batchEmpty);
      return;
    }
    try {
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
    setPlaces({ rows: [], busy: true, error: "" });
    try {
      const rows = await active.listPlaces();
      setPlaces({ rows, busy: false, error: "" });
    } catch (err) {
      setPlaces({ rows: [], busy: false, error: describeError(toFileError(err)) });
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
      (event.target as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
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
    if (places) document.querySelector<HTMLElement>(".file-places [data-focusable]")?.focus();
  }, [places]);

  useEffect(() => {
    if (conflict) document.querySelector<HTMLElement>(".file-conflict [data-focusable]")?.focus();
  }, [conflict]);

  // 手柄回调注册一次就够：里面全走 handlersRef / actionsRef 读最新的闭包，
  // 不然 rAF 里拿到的会是第一次渲染时的状态（老代码踩过这个坑）。
  const handlersRef = useRef({ back, openMenu, toggleSelect, dismissAll, switchPaneDirection });
  handlersRef.current = { back, openMenu, toggleSelect, dismissAll, switchPaneDirection };

  useEffect(() => {
    setFileActions({
      blocksTabs: () => actionsRef.current.dialogOpen || actionsRef.current.selectMode,
      dismiss: () => handlersRef.current.dismissAll(),
      openMenu: () => handlersRef.current.openMenu(),
      toggleSelect: () => handlersRef.current.toggleSelect(),
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

  const batchPairs = batch ? batchPlan(batch) : [];
  const targets = menu ? targetsFor(menu, activePane) : [];

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
    <main className="page library-page">
      <div className="library-head">
        <div className="files-title-row">
          <div className="file-view-toggle" data-focus-zone="files-view" role="group" aria-label={text().files.viewMode}>
            <button
              type="button"
              className={layout === "list" ? "file-view is-current" : "file-view"}
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
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className={layout === "grid" ? "file-view is-current" : "file-view"}
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
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <rect x="2" y="2" width="5.5" height="5.5" rx="1" fill="currentColor" />
                <rect x="10.5" y="2" width="5.5" height="5.5" rx="1" fill="currentColor" />
                <rect x="2" y="10.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
                <rect x="10.5" y="10.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              className={dual ? "file-view file-view-wide is-current" : "file-view file-view-wide"}
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
              <svg width="20" height="18" viewBox="0 0 20 18" aria-hidden>
                <rect x="1" y="3" width="8" height="12" rx="1.5" fill="currentColor" />
                <rect x="11" y="3" width="8" height="12" rx="1.5" fill="currentColor" opacity="0.45" />
              </svg>
            </button>
          </div>
          <div className="file-sort-group" data-focus-zone="files-sort" role="group" aria-label={text().files.sortBy}>
            {(["name", "size", "time", "type"] as SortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className={active.sortKey === key ? "file-sort is-current" : "file-sort"}
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
        </div>
        <div className="library-tools" data-focus-zone="files-tools">
          <button
            type="button"
            className="library-tool"
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
            className="library-tool"
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
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={(active.clip?.items.length ?? 0) === 0}
            onClick={() => void pasteInto(activePane, active.location)}
          >
            {text().files.paste}
            {active.clip ? ` (${active.clip.items.length})` : ""}
          </button>
          {/* 「全选 / 取消全选」是一颗按钮：已经选了东西就是取消（清空 + 退出选择模式），
              什么都没选才是全选。标签和动作必须说同一件事 —— 以前 Y 菜单里写着「取消全选」、
              按下去却是全选，用户会以为自己把整个目录选中了。 */}
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={entries.length === 0}
            onClick={() => (pickedNow.length > 0 ? dropSelection(activePane) : selectAll(activePane))}
          >
            {pickedNow.length > 0 ? text().files.clearSelection : text().files.selectAll}
          </button>
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={active.location == null}
            onClick={() => void active.up()}
          >
            {text().files.up}
          </button>
          <button type="button" className="library-tool" data-focusable onClick={() => void openPlaces()}>
            {text().files.places}
          </button>
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={active.location == null}
            onClick={openSearch}
          >
            {text().files.search}
          </button>
        </div>
        <p className="preview-note">{hint}</p>
      </div>

      <div className={dual ? "file-panes is-dual" : "file-panes"}>
        <FilePane
          browser={left}
          pane="left"
          zone="files-list"
          active={activePane === "left"}
          dual={dual}
          layout={layout}
          picked={picked.left}
          sizes={left.dirSizes}
          selectMode={selectMode}
          firstRef={leftFirst}
          listRef={leftList}
          onActivatePane={() => setActivePane("left")}
          onFocusRow={(index) => focusRowFor("left", index)}
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
            picked={picked.right}
            sizes={right.dirSizes}
            selectMode={selectMode}
            firstRef={rightFirst}
            listRef={rightList}
            onActivatePane={() => setActivePane("right")}
            onFocusRow={(index) => focusRowFor("right", index)}
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
      </div>



      {running.length > 0 && (
        <section className="file-progress" data-focus-zone="files-progress" aria-live="polite">
          {running.map((job) => {
            const scanning = job.phase === "scan";
            const percent = job.totalBytes > 0 ? Math.min(100, Math.round((job.bytes / job.totalBytes) * 100)) : 0;
            return (
              <div key={job.id} className="file-progress-row">
                <span className="file-progress-name">{job.name || text().files.folder}</span>
                <span className="file-progress-bar" aria-hidden>
                  <span className="file-progress-fill" style={{ width: `${scanning ? 0 : percent}%` }} />
                </span>
                <span className="file-progress-meta">
                  {scanning
                    ? text().files.transferScan
                    : text().files.transferMeta(
                        job.itemIndex + 1,
                        job.itemTotal,
                        formatBytes(job.bytes),
                        formatBytes(job.totalBytes),
                      )}
                </span>
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
            <ul className="file-batch-preview">
              {batch.items.slice(0, 8).map((item) => {
                const pair = batchPairs.find((entry) => entry.from === item.path);
                return (
                  <li key={item.path}>
                    <span className="file-batch-from">{item.name}</span>
                    <span aria-hidden>→</span>
                    <span className={pair ? "file-batch-to" : "file-batch-to is-same"}>
                      {pair ? pair.to : text().files.batchUnchanged}
                    </span>
                  </li>
                );
              })}
            </ul>
            {batch.items.length > 8 && (
              <p className="group-empty">{text().files.batchMore(batch.items.length - 8)}</p>
            )}
            <p className="group-empty">{formError || text().files.batchKeyboard}</p>
            <div className="library-tools">
              <button type="submit" className="library-tool" data-focusable disabled={batchPairs.length === 0}>
                {text().files.batchRun}
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

      {places && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setPlaces(null)}
          />
          <div className="group-dialog-panel file-places" role="dialog" aria-label={text().files.placesTitle}>
            <h2>{text().files.placesTitle}</h2>
            {places.busy ? (
              <p className="group-empty">{text().files.propsReading}</p>
            ) : places.error ? (
              <p className="group-empty">{places.error}</p>
            ) : (
              <div className="file-places-list" data-focus-zone="files-places-list">
                {places.rows.map((row) => (
                  <button
                    key={row.path}
                    type="button"
                    className="file-row"
                    data-focusable
                    onClick={() => {
                      active.jump(row.path);
                      setPlaces(null);
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
              <button type="button" className="library-tool" data-focusable onClick={() => setPlaces(null)}>
                {text().close}
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
                  void active.remove(targetsToDelete);
                  if (activePane === "left") void right.reload();
                  else void left.reload();
                }}
              >
                {text().delete}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

