import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playSfx } from "../audio/sfx";
import { currentLocale, text, useI18n } from "../i18n";

export type FileEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  bytes: number;
  /** 修改时间（Unix 毫秒，0 = 未知）。 */
  modified: number;
  editable: boolean;
  /** 隐藏属性 / 点开头的名字：默认不列出来，工具栏那颗「显示隐藏」才放它们进来。 */
  hidden: boolean;
};

export type SortKey = "name" | "size" | "time" | "type";
export type SortDir = "asc" | "desc";
/** 同名怎么处理：覆盖 / 跳过 / 保留两者。默认保留两者 —— 不删用户的东西才安全。 */
export type Conflict = "replace" | "skip" | "keep";

export type SearchHit = {
  name: string;
  path: string;
  kind: "dir" | "file";
  bytes: number;
  modified: number;
  relative: string;
};

export type FileProperties = {
  name: string;
  path: string;
  kind: "dir" | "file";
  bytes: number;
  sizeComplete: boolean;
  modified: number;
  created: number;
  extension: string;
  readonly: boolean;
  hidden: boolean;
  writable: boolean;
  writeReason: string;
  protected: boolean;
};

/** Rust 侧把失败拆成「机器码 + 人话」，前端按码给不同的建议（见 files.rs::FileError）。 */
export type FileErrorInfo = { reason: string; message: string };

/**
 * 文件夹在列表里显示的大小。文件夹的大小只能走一遍盘（后端 `file_dir_sizes`），
 * 所以是**异步补上来**的：`complete: false` 时 `bytes` 是下限（界面加「≥」）。
 */
export type DirSize = { bytes: number; complete: boolean };

export type DirSizeRow = DirSize & { path: string };

export type Crumb = { label: string; path: string | null };

type ClipItem = {
  path: string;
  name: string;
  kind: "dir" | "file";
};

type Clip = {
  items: ClipItem[];
  mode: "copy" | "move";
};

/** 传输只关心这三样：路径、名字、是不是文件夹。FileEntry 和剪贴板里的项都符合。 */
export type TransferItem = { path: string; name: string; kind: "dir" | "file" };

type PreviewNode = {
  name: string;
  kind: "dir" | "file";
  editable?: boolean;
  text?: string;
  children?: PreviewNode[];
};

const PREVIEW_ROOT = "preview:";

/** 每次任务一个编号：进度事件按它认领，取消也按它找。 */
export function jobId(prefix = "job"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 把后端抛出来的东西统一成 { reason, message }。 */
export function toFileError(err: unknown): FileErrorInfo {
  if (typeof err === "string") return { reason: "other", message: err };
  if (err && typeof err === "object") {
    const info = err as { reason?: unknown; message?: unknown };
    if (typeof info.message === "string") {
      return { reason: typeof info.reason === "string" ? info.reason : "other", message: info.message };
    }
  }
  if (err instanceof Error && err.message) return { reason: "other", message: err.message };
  return { reason: "other", message: text().files.actionFailed };
}

function previewTree(): PreviewNode {
  const en = currentLocale() === "en";
  return {
    name: text().files.previewRoot,
    kind: "dir",
    children: [
      {
        name: en ? "Documents" : "文档",
        kind: "dir",
        children: [
          {
            name: en ? "Note.txt" : "笔记.txt",
            kind: "file",
            editable: true,
            text: en
              ? "This is a preview note.\nMove focus to Save, then press A."
              : "这是预览笔记。\n改完后把焦点移到保存，按 A。",
          },
        ],
      },
      {
        name: en ? "Readme.txt" : "说明.txt",
        kind: "file",
        editable: true,
        text: en ? "Files in the browser are not written to disk." : "浏览器里的文件不会写到磁盘。",
      },
      { name: en ? "Cover.png" : "封面.png", kind: "file", editable: false },
    ],
  };
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}


export function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".zip") || lower.endsWith(".7z");
}

export function checkFileName(name: string): string | null {
  const t = text().files;
  const trimmed = name.trim();
  if (!trimmed) return t.needName;
  if (trimmed === "." || trimmed === ".." || trimmed.length > 120) return t.badName;
  if (/[\\/:*?"<>|]/.test(trimmed) || [...trimmed].some((c) => c.charCodeAt(0) < 32)) {
    return t.badChars;
  }
  const stem = (trimmed.split(".")[0] ?? trimmed).toUpperCase();
  if (["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "LPT1", "LPT2"].includes(stem)) {
    return t.badName;
  }
  return null;
}

export function parentPath(path: string): string | null {
  if (path === PREVIEW_ROOT) return null;
  if (path.startsWith(`${PREVIEW_ROOT}/`)) {
    const rest = path.slice(PREVIEW_ROOT.length + 1);
    const idx = rest.lastIndexOf("/");
    return idx < 0 ? PREVIEW_ROOT : `${PREVIEW_ROOT}/${rest.slice(0, idx)}`;
  }
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx < 0) return null;
  if (idx === 0) return path.includes("\\") ? null : "/";
  const parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

export function baseName(path: string | null): string {
  if (path == null) return text().files.drivesTitle;
  if (path === PREVIEW_ROOT) return text().files.previewRoot;
  if (path === "/") return text().files.root;
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function childPath(parent: string, name: string): string {
  if (parent === PREVIEW_ROOT) return `${PREVIEW_ROOT}/${name}`;
  if (parent.startsWith(`${PREVIEW_ROOT}/`)) return `${parent}/${name}`;
  if (/^[A-Za-z]:\\?$/.test(parent)) return `${parent.replace(/\\?$/, "\\")}${name}`;
  const sep = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]$/, "")}${sep}${name}`;
}

function cloneNode(node: PreviewNode): PreviewNode {
  return {
    ...node,
    children: node.children?.map(cloneNode),
  };
}

function findNode(root: PreviewNode, path: string): PreviewNode | null {
  if (path === PREVIEW_ROOT) return root;
  if (!path.startsWith(`${PREVIEW_ROOT}/`)) return null;
  let node: PreviewNode | null = root;
  for (const part of path.slice(PREVIEW_ROOT.length + 1).split("/")) {
    node = node?.children?.find((child) => child.name === part) ?? null;
  }
  return node;
}

function previewBytes(node: PreviewNode): number {
  if (node.kind === "file") return new TextEncoder().encode(node.text ?? "").length;
  return (node.children ?? []).reduce((total, child) => total + previewBytes(child), 0);
}

function toEntry(node: PreviewNode, path: string): FileEntry {
  return {
    name: node.name,
    path,
    kind: node.kind,
    bytes: previewBytes(node),
    // 预览里的文件没有真实时间：给 0（未知），按时间排序就退化成按名字。
    modified: 0,
    editable: node.kind === "file" && node.editable !== false,
    hidden: false,
  };
}

function listPreview(root: PreviewNode, location: string | null): FileEntry[] {
  if (location == null) {
    return [toEntry(root, PREVIEW_ROOT)];
  }
  const node = findNode(root, location);
  if (!node || node.kind !== "dir") return [];
  return (node.children ?? []).map((child) => toEntry(child, childPath(location, child.name)));
}

function uniqueName(siblings: PreviewNode[], name: string): string {
  if (!siblings.some((child) => child.name === name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 100; n += 1) {
    const candidate = text().files.copyName(stem, n, ext);
    if (!siblings.some((child) => child.name === candidate)) return candidate;
  }
  return `${name}.copy`;
}

function updateDir(
  root: PreviewNode,
  path: string,
  change: (children: PreviewNode[]) => PreviewNode[],
): PreviewNode {
  if (path === PREVIEW_ROOT) {
    return { ...root, children: change(root.children ?? []) };
  }
  const parent = parentPath(path);
  const name = baseName(path);
  if (parent == null) return root;
  return updateDir(root, parent, (children) =>
    children.map((child) =>
      child.name === name && child.kind === "dir"
        ? { ...child, children: change(child.children ?? []) }
        : child,
    ),
  );
}


function applyPreviewPaste(
  tree: PreviewNode,
  clip: ClipItem & { mode: Clip["mode"] },
  location: string,
): { tree: PreviewNode; focus: string; message: string } | { error: string } {
  const t = text().files;
  const source = findNode(tree, clip.path);
  if (!source) return { error: t.missingPaste };
  const parent = parentPath(clip.path);
  if (clip.mode === "move" && parent === location) return { error: t.alreadyHere };
  if (clip.kind === "dir" && (location === clip.path || location.startsWith(`${clip.path}/`))) {
    return { error: t.intoItself };
  }
  const dest = findNode(tree, location);
  if (!dest || dest.kind !== "dir") return { error: t.pasteIntoFolder };
  const siblings = dest.children ?? [];
  if (clip.mode === "move" && siblings.some((child) => child.name === source.name)) {
    return { error: t.nameTaken };
  }
  const focus = clip.mode === "copy" ? uniqueName(siblings, source.name) : source.name;
  let next = updateDir(tree, location, (children) => [...children, { ...cloneNode(source), name: focus }]);
  if (clip.mode === "move" && parent) {
    next = updateDir(next, parent, (children) => children.filter((child) => child.name !== source.name));
  }
  return {
    tree: next,
    focus,
    message: clip.mode === "copy" ? text().files.pasted(focus) : text().files.moved(focus),
  };
}

function renamePreview(
  tree: PreviewNode,
  path: string,
  nextName: string,
): { tree: PreviewNode; focus: string } | { error: string } {
  const t = text().files;
  const parent = parentPath(path);
  if (parent == null) return { error: t.cannotRenameHere };
  const name = baseName(path);
  const dir = findNode(tree, parent);
  if (!dir || dir.kind !== "dir") return { error: t.cannotRenameHere };
  if ((dir.children ?? []).some((child) => child.name === nextName && child.name !== name)) {
    return { error: t.nameTaken };
  }
  return {
    tree: updateDir(tree, parent, (children) =>
      children.map((child) => (child.name === name ? { ...child, name: nextName } : child)),
    ),
    focus: nextName,
  };
}

function searchPreview(root: PreviewNode, query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  const walk = (node: PreviewNode, path: string, where: string) => {
    for (const child of node.children ?? []) {
      const childWalk = childPath(path, child.name);
      if (child.name.toLowerCase().includes(needle)) {
        hits.push({ ...toEntry(child, childWalk), relative: where });
      }
      if (child.kind === "dir") walk(child, childWalk, where ? `${where}/${child.name}` : child.name);
    }
  };
  walk(root, PREVIEW_ROOT, "");
  return hits;
}

function propertiesPreview(root: PreviewNode, path: string): FileProperties | null {
  const node = path === PREVIEW_ROOT ? root : findNode(root, path);
  if (!node) return null;
  const entry = toEntry(node, path);
  const dot = node.name.lastIndexOf(".");
  const editable = node.kind === "file" && node.editable !== false;
  return {
    name: node.name,
    path,
    kind: node.kind,
    bytes: entry.bytes,
    sizeComplete: true,
    modified: 0,
    created: 0,
    extension: node.kind === "file" && dot > 0 ? node.name.slice(dot + 1).toLowerCase() : "",
    readonly: node.kind === "file" && !editable,
    hidden: false,
    writable: node.kind === "file" ? editable : true,
    writeReason: "",
    protected: false,
  };
}

/**
 * 面包屑：从「位置」一路到当前目录，每一段都能点回去。
 *
 * Windows 的 `C:\` 和 UNC（`\\server\share`）都要还原成能直接用的路径，
 * 不然点一下会跳到一个不存在的目录。
 */
export function crumbsFor(location: string | null): Crumb[] {
  const t = text().files;
  const head: Crumb = { label: t.drivesTitle, path: null };
  if (location == null) return [head];
  if (location === PREVIEW_ROOT) return [head, { label: t.previewRoot, path: PREVIEW_ROOT }];
  if (location.startsWith(`${PREVIEW_ROOT}/`)) {
    const parts = location.slice(PREVIEW_ROOT.length + 1).split("/");
    const out: Crumb[] = [head, { label: t.previewRoot, path: PREVIEW_ROOT }];
    parts.forEach((part, index) => {
      out.push({ label: part, path: `${PREVIEW_ROOT}/${parts.slice(0, index + 1).join("/")}` });
    });
    return out;
  }
  if (location === "/") return [head, { label: t.root, path: "/" }];

  const parts = location.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
  const out: Crumb[] = [head];
  if (location.startsWith("\\\\")) {
    const [server, share, ...rest] = parts;
    if (server && share) {
      let current = `\\\\${server}\\${share}`;
      out.push({ label: `${server}\\${share}`, path: `${current}\\` });
      for (const part of rest) {
        current = `${current}\\${part}`;
        out.push({ label: part, path: current });
      }
    }
    return out;
  }
  const absolute = location.startsWith("/");
  if (absolute) out.push({ label: t.root, path: "/" });
  const sep = location.includes("\\") ? "\\" : "/";
  let current = absolute ? "/" : "";
  for (const part of parts) {
    if (!current) current = part;
    else if (/^[A-Za-z]:$/.test(current)) current = `${current}${sep}${part}`;
    else current = `${current.replace(/[\\/]+$/, "")}${sep}${part}`;
    out.push({ label: part, path: current });
  }
  return out;
}

function sortRows(
  rows: FileEntry[],
  key: SortKey,
  dir: SortDir,
  sizes: Record<string, DirSize>,
): FileEntry[] {
  const flip = dir === "asc" ? 1 : -1;
  const extensionOf = (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  };
  // 文件夹的大小是异步补上来的（还没算出来就是 0）；按大小排时就用它，
  // 数字分批到位的顺序就是排序自己慢慢稳定的过程，不用额外刷新。
  const weight = (entry: FileEntry) => (entry.kind === "dir" ? sizes[entry.path]?.bytes ?? 0 : entry.bytes);
  return [...rows].sort((a, b) => {
    // 目录永远排在前面：按时间找刚拷进来的游戏时，文件夹混在文件中间更难认。
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    let order = 0;
    if (key === "size") order = weight(a) - weight(b);
    else if (key === "time") order = a.modified - b.modified;
    else if (key === "type") order = extensionOf(a.name).localeCompare(extensionOf(b.name), currentLocale());
    if (order === 0) order = a.name.localeCompare(b.name, currentLocale());
    return order * flip;
  });
}


/// The Files tab is unmounted on every tab switch (`key={tab}` in App.tsx), so
/// its folder and rows used to be thrown away: coming back re-asked for the
/// drive list and flashed "loading" again. Keep the last listing for this app
/// session so a remount paints immediately, then refresh in the background.
/// (Fresh answers skip the refresh entirely; the Rust side now does the walk
/// off the event loop, but repeating it for nothing is still wasted work.)
const LISTING_FRESH_MS = 3000;

type SessionListing = { location: string | null; rows: FileEntry[]; at: number };

/// 每个栏位各记一份「上次看到的目录」：双栏时左右两栏各看各的，不能互相覆盖。
const sessionListings = new Map<string, SessionListing>();
const sessionFolders = new Map<string, SessionListing>();

function lastListing(key: string): SessionListing | null {
  return sessionListings.get(key) ?? null;
}

function cachedRows(key: string, location: string | null): FileEntry[] {
  const last = lastListing(key);
  if (last !== null && last.location === location) return last.rows;
  if (location !== null) return sessionFolders.get(location)?.rows ?? [];
  return [];
}

function rememberRows(key: string, location: string | null, rows: FileEntry[]) {
  const entry: SessionListing = { location, rows, at: Date.now() };
  sessionListings.set(key, entry);
  if (location !== null) sessionFolders.set(location, entry);
}

function listingIsFresh(key: string, location: string | null): boolean {
  const last = lastListing(key);
  if (last === null || last.location !== location) return false;
  return Date.now() - last.at < LISTING_FRESH_MS;
}

// 文件夹大小是走盘算出来的：同一次会话里同一个目录别重复算（掌机上那几秒是实打实的），
// 来回翻两个目录时尤其明显。但拷完东西大小就变了，所以给个 TTL，过期重算。
// 按**路径**存（不按栏位）：左右两栏看同一个目录时共用一份结果。
const DIR_SIZE_TTL_MS = 60_000;

const sessionDirSizes = new Map<string, DirSize & { at: number }>();

// 分开「已经知道的」和「要算的」：已知的直接填界面，缺的才往后端要。
function freshDirSizes(paths: string[]): { known: Record<string, DirSize>; missing: string[] } {
  const known: Record<string, DirSize> = {};
  const missing: string[] = [];
  const now = Date.now();
  for (const path of paths) {
    const hit = sessionDirSizes.get(path);
    if (hit && now - hit.at < DIR_SIZE_TTL_MS) {
      known[path] = { bytes: hit.bytes, complete: hit.complete };
    } else {
      missing.push(path);
    }
  }
  return { known, missing };
}

function rememberDirSizes(rows: DirSizeRow[]) {
  const at = Date.now();
  for (const row of rows) {
    sessionDirSizes.set(row.path, { bytes: row.bytes, complete: row.complete, at });
  }
}

const SORT_KEY = "handheld-launcher.files.sort";
const SORT_DIR = "handheld-launcher.files.sortDir";

function loadSort(): { key: SortKey; dir: SortDir } {
  let key: string | null = null;
  let dir: string | null = null;
  try {
    key = localStorage.getItem(SORT_KEY);
    dir = localStorage.getItem(SORT_DIR);
  } catch {
    /* private mode */
  }
  return {
    key: key === "size" || key === "time" || key === "type" ? key : "name",
    dir: dir === "desc" ? "desc" : "asc",
  };
}

function saveSort(key: SortKey, dir: SortDir) {
  try {
    localStorage.setItem(SORT_KEY, key);
    localStorage.setItem(SORT_DIR, dir);
  } catch {
    /* private mode */
  }
}

/** 前端自己造出来的失败（校验没过），形状和后端抛的一致。 */
function fileError(reason: string, message: string): FileErrorInfo {
  return { reason, message };
}

export type UseFileBrowserOptions = {
  cacheKey?: string;
  /**
   * 要不要算文件夹大小（默认算）。选程序的那个对话框里满屏都是文件夹，而它只关心 .exe，
   * 走盘算大小纯属白干 —— 那边传 false。
   */
  measureDirSizes?: boolean;
  /**
   * 这一栏要**换目录**了，在 `setLocation` 之前同步调一次。页面用它把「选中的东西」清掉、
   * 退出选择模式 —— 不能等 effect：新目录的第一行会自动拿到焦点，那时要是还在选择模式，
   * 就会顺手把第一行选上，用户看到的是一个莫名其妙的勾。
   */
  onNavigate?: () => void;
  /**
   * 要不要把隐藏文件（Windows 隐藏属性 / 点开头的名字）也列出来。默认不列 ——
   * 掌机上 `AppData`、`desktop.ini` 这类东西只会把列表弄乱。按栏传，两栏可以不一样。
   */
  showHidden?: boolean;
};


export function useFileBrowser(options: UseFileBrowserOptions = {}) {
  const cacheKey = options.cacheKey ?? "main";
  const measure = options.measureDirSizes !== false;
  const { locale } = useI18n();
  const preview = !inTauri();
  const [location, setLocation] = useState<string | null>(() =>
    preview ? null : lastListing(cacheKey)?.location ?? null,
  );
  const [tree, setTree] = useState<PreviewNode>(() => previewTree());
  const [nativeEntries, setNativeEntries] = useState<FileEntry[]>(() =>
    preview ? [] : cachedRows(cacheKey, lastListing(cacheKey)?.location ?? null),
  );
  const [note, setNote] = useState("");
  /**
   * 当前这个位置**读失败**的原因（FUTURE.md 功能 14 第 15 条）。
   *
   * 为什么单独一个 state，而不是只往 `note` 里塞一句话：列表读不出来时，`.k7-empty`
   * 还在写「这个文件夹是空的」—— 那是假话（盘拔了、权限没了都会走这条）。分开之后
   * 面板能说清楚是「空」还是「读不了」，再给一句往哪走。
   */
  const [loadError, setLoadError] = useState("");
  const [clip, setClip] = useState<Clip | null>(null);
  const [pendingFocus, setPendingFocus] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(() => loadSort().key);
  const [sortDir, setSortDir] = useState<SortDir>(() => loadSort().dir);
  // `nativeEntries` 是**哪个目录**的内容。换目录后要等新的一批读回来，中间这段时间里
  // 列表上还是上一级的行：算大小、落焦点都得认这个，不能认 `location`。
  const [rowsFor, setRowsFor] = useState<string | null>(() =>
    preview ? null : lastListing(cacheKey)?.location ?? null,
  );
  const [dirSizes, setDirSizes] = useState<Record<string, DirSize>>({});
  // `jump` 是 `[]` 依赖的回调，拿不到最新的 props：回调过一层 ref（老代码里手柄回调也这么办）。
  const navigateRef = useRef(options.onNavigate);
  navigateRef.current = options.onNavigate;

  useEffect(() => {
    if (preview) setTree(previewTree());
  }, [locale, preview]);

  const reloadNative = useCallback(
    async (path: string | null) => {
      try {
        const rows =
          path == null
            ? await invoke<FileEntry[]>("file_places")
            : await invoke<FileEntry[]>("file_list", { path });
        rememberRows(cacheKey, path, rows);
        setNativeEntries(rows);
        setRowsFor(path);
        setLoadError("");
      } catch (err) {
        setNativeEntries([]);
        setRowsFor(path);
        const message = toFileError(err).message;
        setLoadError(message);
        setNote((current) => (current ? `${current}\n${message}` : message));
      }
    },
    [cacheKey],
  );

  useEffect(() => {
    if (preview) return;
    if (listingIsFresh(cacheKey, location)) return;
    let cancel = false;
    void (async () => {
      try {
        const rows =
          location == null
            ? await invoke<FileEntry[]>("file_places")
            : await invoke<FileEntry[]>("file_list", { path: location });
        if (!cancel) {
          rememberRows(cacheKey, location, rows);
          setNativeEntries(rows);
          setRowsFor(location);
          setLoadError("");
        }
      } catch (err) {
        if (!cancel) {
          setNativeEntries([]);
          setRowsFor(location);
          const message = toFileError(err).message;
          setLoadError(message);
          setNote(message);
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [cacheKey, location, preview]);

  const rows = preview ? listPreview(tree, location) : nativeEntries;
  // 隐藏项默认不显示：过滤只发生在「要显示的那一份」上，索引与 pick / 选区的对应用的是同一个数组。
  const shownRows = useMemo(
    () => (options.showHidden ? rows : rows.filter((row) => !row.hidden)),
    [rows, options.showHidden],
  );
  const entries = useMemo(
    () => sortRows(shownRows, sortKey, sortDir, dirSizes),
    [shownRows, sortKey, sortDir, dirSizes],
  );
  const crumbs = useMemo(() => crumbsFor(location), [location, locale]);

  /**
   * 「这一栏现在显示的是哪一批行」的指纹（目录 + 每行的路径）。
   * FilesPage 靠它知道新目录的内容**真的到了**，才动焦点：换目录那一瞬间列表上还是上一级的行，
   * 那时候把焦点落到「第一行」等于落在旧行上，等新行到位那行就被删了 —— 焦点掉回 body，
   * 手柄下一次按方向键就跑到页面最上面那个按钮（显示模式）去了。
   */
  const rowsToken = useMemo(
    () => `${rowsFor ?? ""}\u0000${rows.map((row) => row.path).join("\n")}`,
    [rows, rowsFor],
  );

  // 文件夹大小：进目录后后台算，算好一批填一批。走盘是秒级的活，绝不能挡在「进目录」前面；
  // 换目录时把后端那个活儿也停掉，别让它接着走上一级的盘。
  useEffect(() => {
    if (!measure || preview || rowsFor !== location || location == null) return;
    const dirs = nativeEntries.filter((entry) => entry.kind === "dir").map((entry) => entry.path);
    if (dirs.length === 0) return;
    const { known, missing } = freshDirSizes(dirs);
    if (Object.keys(known).length > 0) setDirSizes((current) => ({ ...current, ...known }));
    if (missing.length === 0) return;
    const id = jobId("sizes");
    let stopped = false;
    void (async () => {
      try {
        const found = await invoke<DirSizeRow[]>("file_dir_sizes", { id, parent: location });
        if (stopped) return;
        rememberDirSizes(found);
        setDirSizes((current) => {
          const next = { ...current };
          for (const row of found) next[row.path] = { bytes: row.bytes, complete: row.complete };
          return next;
        });
      } catch {
        // 算不出大小只是列表上少个数字：这不是用户点出来的操作，不弹提示打扰他。
      }
    })();
    return () => {
      stopped = true;
      void invoke("file_cancel", { id }).catch(() => undefined);
    };
  }, [location, nativeEntries, preview, rowsFor, measure]);

  const chooseSort = useCallback(
    (key: SortKey) => {
      // 再点同一个键就换方向：手柄上没有「另一个键」，同一个键切正反最省事。
      const nextDir: SortDir = key === sortKey && sortDir === "asc" ? "desc" : "asc";
      setSortKey(key);
      setSortDir(nextDir);
      saveSort(key, nextDir);
    },
    [sortDir, sortKey],
  );

  const jump = useCallback((path: string | null, focusName = "") => {
    // 先告诉页面「要换目录了」：清选中、退出选择模式。必须在 `setLocation` 之前同步调，
    // 理由见 `UseFileBrowserOptions.onNavigate`。
    navigateRef.current?.();
    setLocation(path);
    setNote("");
    setPendingFocus(focusName);
  }, []);

  const enter = useCallback(
    (entry: FileEntry) => {
      if (entry.kind !== "dir") return;
      jump(entry.path);
    },
    [jump],
  );

  const up = useCallback(() => {
    if (location == null) return false;
    // 返回上一级时把落点定成「刚出来的那个文件夹」：不然每次返回都从第一行重新往下按。
    jump(parentPath(location), baseName(location));
    return true;
  }, [jump, location]);

  const stage = useCallback((items: FileEntry[], mode: Clip["mode"]) => {
    if (items.length === 0) return;
    setClip({
      items: items.map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind })),
      mode,
    });
    const t = text().files;
    const label =
      items.length === 1
        ? t.quoted(items[0].name)
        : currentLocale() === "zh"
          ? ` ${t.itemCount(items.length)}`
          : t.itemCount(items.length);
    setNote(mode === "copy" ? t.copiedClip(label) : t.moveClip(label));
  }, []);


  /**
   * 把清单交给后端搬：命令立刻返回，进度走 `files-transfer` 事件（页面在听）。
   * 目标默认是这一栏的当前目录；双栏时页面会传另一栏的目录。
   * 返回任务编号；界面按它显示进度条和取消。
   */
  const startTransfer = useCallback(
    async (
      items: TransferItem[],
      mode: Clip["mode"],
      conflict: Conflict,
      destDir: string | null = location,
    ): Promise<string> => {
      if (items.length === 0) return "";
      if (destDir == null) {
        setNote(text().files.enterFolderFirst);
        return "";
      }
      const id = jobId(mode);
      if (preview) {
        // 预览模式没有后端：在内存树上模拟一次，界面照样能试。
        // （每栏各有一份内存树，跨栏搬没有共同的那棵树，所以只支持本栏。）
        if (destDir !== location) {
          setNote(text().files.previewCross);
          return "";
        }
        let next = tree;
        let focus = items[0].name;
        const done: string[] = [];
        for (const item of items) {
          const applied = applyPreviewPaste(
            next,
            { path: item.path, name: item.name, kind: item.kind, mode },
            destDir,
          );
          if ("error" in applied) {
            setTree(next);
            setNote(done.length > 0 ? text().files.partial(done.length, applied.error) : applied.error);
            return "";
          }
          next = applied.tree;
          focus = applied.focus;
          done.push(item.path);
        }
        setTree(next);
        playSfx("paste");
        setPendingFocus(focus);
        setNote(
          items.length === 1
            ? mode === "copy"
              ? text().files.pasted(focus)
              : text().files.moved(focus)
            : mode === "copy"
              ? text().files.pastedMany(text().files.itemCount(items.length))
              : text().files.movedMany(text().files.itemCount(items.length)),
        );
        return id;
      }
      try {
        await invoke("file_transfer", {
          id,
          items: items.map((item) => item.path),
          destDir,
          mode,
          conflict,
        });
      } catch (err) {
        setNote(toFileError(err).message);
        return "";
      }
      return id;
    },
    [location, preview, tree],
  );

  const paste = useCallback(
    async (conflict: Conflict = "keep") => {
      if (!clip || clip.items.length === 0) return "";
      const id = await startTransfer(clip.items, clip.mode, conflict);
      if (id && clip.mode === "move") setClip(null);
      return id;
    },
    [clip, startTransfer],
  );

  const createDir = useCallback(
    async (name: string) => {
      const problem = checkFileName(name);
      if (problem) throw fileError("name", problem);
      if (location == null) throw fileError("rule", text().files.enterFolderFirst);
      const trimmed = name.trim();
      if (preview) {
        const dest = findNode(tree, location);
        if (dest?.children?.some((child) => child.name === trimmed)) {
          throw fileError("exists", text().files.nameTaken);
        }
        setTree((current) =>
          updateDir(current, location, (children) => [
            ...children,
            { name: trimmed, kind: "dir", children: [] },
          ]),
        );
        setPendingFocus(trimmed);
        setNote(text().files.folderCreated(trimmed));
        return trimmed;
      }
      await invoke("file_make_dir", { parent: location, name: trimmed });
      setPendingFocus(trimmed);
      setNote(text().files.folderCreated(trimmed));
      await reloadNative(location);
      return trimmed;
    },
    [location, preview, reloadNative, tree],
  );

  const createFile = useCallback(
    async (name: string) => {
      const problem = checkFileName(name);
      if (problem) throw fileError("name", problem);
      if (location == null) throw fileError("rule", text().files.enterFolderFirst);
      const trimmed = name.trim();
      if (preview) {
        const dest = findNode(tree, location);
        if (dest?.children?.some((child) => child.name === trimmed)) {
          throw fileError("exists", text().files.nameTaken);
        }
        setTree((current) =>
          updateDir(current, location, (children) => [
            ...children,
            { name: trimmed, kind: "file", editable: true, text: "" },
          ]),
        );
        setPendingFocus(trimmed);
        setNote(text().files.fileCreated(trimmed));
        return childPath(location, trimmed);
      }
      await invoke("file_make_file", { parent: location, name: trimmed });
      setPendingFocus(trimmed);
      setNote(text().files.fileCreated(trimmed));
      await reloadNative(location);
      return childPath(location, trimmed);
    },
    [location, preview, reloadNative, tree],
  );


  const readText = useCallback(
    async (entry: FileEntry) => {
      if (preview) {
        const node = findNode(tree, entry.path);
        if (!node || node.kind !== "file" || node.editable === false) {
          throw fileError("binary", text().files.notText);
        }
        return node.text ?? "";
      }
      return invoke<string>("file_read_text", { path: entry.path });
    },
    [preview, tree],
  );

  const writeText = useCallback(
    async (path: string, body: string) => {
      if (preview) {
        const parent = parentPath(path);
        const name = baseName(path);
        if (parent == null) throw fileError("rule", text().files.cannotSave);
        setTree((current) =>
          updateDir(current, parent, (children) =>
            children.map((child) => (child.name === name ? { ...child, text: body } : child)),
          ),
        );
        setNote(text().files.saved(name));
        return;
      }
      await invoke("file_write_text", { path, text: body });
      setNote(text().files.saved(baseName(path)));
    },
    [preview],
  );

  const remove = useCallback(
    /** `permanent` = 不经过回收站。默认走回收站：掌机上删错东西太容易了。 */
    async (items: FileEntry[], permanent = false) => {
      if (items.length === 0) return;
      if (preview) {
        let next = tree;
        for (const entry of items) {
          const parent = parentPath(entry.path);
          if (parent == null) {
            setNote(text().files.cannotDeleteHere);
            return;
          }
          next = updateDir(next, parent, (children) =>
            children.filter((child) => child.name !== entry.name),
          );
        }
        setTree(next);
        setNote(
          items.length === 1
            ? text().files.deletedOne(items[0].name)
            : text().files.deletedMany(items.length),
        );
        return;
      }
      let done = 0;
      let recycled = false;
      let failure = "";
      for (const entry of items) {
        try {
          const outcome = await invoke<{ recycled: boolean }>("file_delete", {
            path: entry.path,
            permanent,
          });
          recycled = outcome?.recycled ?? false;
          done += 1;
        } catch (err) {
          failure = toFileError(err).message;
          break;
        }
      }
      const t = text().files;
      setNote(
        failure
          ? done > 0
            ? `${t.deletedMany(done)} ${failure}`
            : failure
          : recycled
            ? items.length === 1
              ? t.recycledOne(items[0].name)
              : t.recycledMany(done)
            : items.length === 1
              ? t.deletedOne(items[0].name)
              : t.deletedMany(items.length),
      );
      await reloadNative(location);
    },
    [location, preview, reloadNative, tree],
  );

  /** 把选中的项目打成一个 zip，放在同一个目录里（同名自动加序号）。 */
  const compress = useCallback(
    async (items: FileEntry[], name?: string) => {
      if (items.length === 0) return;
      if (preview) {
        setNote(text().files.previewHint);
        return;
      }
      const t = text().files;
      setNote(t.compressing(items.length));
      try {
        const outcome = await invoke<{ archive: string; items: number }>("file_compress", {
          paths: items.map((entry) => entry.path),
          name: name ?? null,
        });
        setNote(t.compressDone(outcome.items, outcome.archive));
        await reloadNative(location);
      } catch (err) {
        setNote(t.compressFailed(toFileError(err).message));
      }
    },
    [location, preview, reloadNative],
  );

  const extract = useCallback(
    async (entry: FileEntry) => {
      if (preview) {
        setNote(text().files.previewHint);
        return;
      }
      const t = text().files;
      setNote(t.extracting(entry.name));
      try {
        const outcome = await invoke<{ dir: string; files: number }>("file_extract", {
          archive: entry.path,
        });
        setNote(t.extractDone(outcome.files, outcome.dir));
        await reloadNative(location);
      } catch (err) {
        // 解压失败时后端会留下一个空目录（已经 create_dir_all 了），重载一下让用户看见它。
        await reloadNative(location);
        setNote(t.extractFailed(entry.name, toFileError(err).message));
      }
    },
    [location, preview, reloadNative],
  );

  const openExternal = useCallback(
    async (entry: FileEntry) => {
      if (preview) {
        setNote(text().files.previewOpen);
        return;
      }
      await invoke("file_open", { path: entry.path });
      setNote(text().files.opened(entry.name));
    },
    [preview],
  );

  const rename = useCallback(
    async (entry: FileEntry, nextName: string) => {
      const problem = checkFileName(nextName);
      if (problem) throw fileError("name", problem);
      const trimmed = nextName.trim();
      if (trimmed === entry.name) return trimmed;
      if (preview) {
        const applied = renamePreview(tree, entry.path, trimmed);
        if ("error" in applied) throw fileError("rule", applied.error);
        setTree(applied.tree);
        setPendingFocus(applied.focus);
        setNote(text().files.renamed(applied.focus));
        return applied.focus;
      }
      await invoke("file_rename", { from: entry.path, to: trimmed });
      setPendingFocus(trimmed);
      setNote(text().files.renamed(trimmed));
      await reloadNative(location);
      return trimmed;
    },
    [location, preview, reloadNative, tree],
  );

  const renameMany = useCallback(
    async (pairs: { from: string; to: string }[]) => {
      if (pairs.length === 0) return { done: 0, failures: [] as { name: string; message: string }[] };
      if (preview) {
        let next = tree;
        let done = 0;
        for (const pair of pairs) {
          const applied = renamePreview(next, pair.from, pair.to.trim());
          if ("error" in applied) {
            setTree(next);
            return { done, failures: [{ name: baseName(pair.from), message: applied.error }] };
          }
          next = applied.tree;
          done += 1;
        }
        setTree(next);
        setPendingFocus(pairs[0].to.trim());
        setNote(text().files.renamedMany(done));
        return { done, failures: [] as { name: string; message: string }[] };
      }
      const report = await invoke<{ done: number; failures: { name: string; message: string }[] }>(
        "file_rename_many",
        { pairs },
      );
      await reloadNative(location);
      return report;
    },
    [location, preview, reloadNative, tree],
  );



  const properties = useCallback(
    async (path: string) => {
      if (preview) {
        const info = propertiesPreview(tree, path);
        if (!info) throw fileError("missing", text().files.cannotReadProperties);
        return info;
      }
      return invoke<FileProperties>("file_properties", { path });
    },
    [preview, tree],
  );

  const search = useCallback(
    async (query: string, id: string) => {
      if (preview) return searchPreview(tree, query);
      if (location == null) throw fileError("rule", text().files.searchInsideFolder);
      return invoke<SearchHit[]>("file_search", { id, root: location, query });
    },
    [location, preview, tree],
  );

  const listPlaces = useCallback(async () => {
    if (preview) return listPreview(tree, PREVIEW_ROOT);
    return invoke<FileEntry[]>("file_places");
  }, [preview, tree]);

  const cancel = useCallback(
    async (id: string) => {
      if (preview || !id) return false;
      try {
        return await invoke<boolean>("file_cancel", { id });
      } catch {
        return false;
      }
    },
    [preview],
  );

  const reload = useCallback(async () => {
    if (!preview) await reloadNative(location);
  }, [location, preview, reloadNative]);

  // 预览模式（浏览器里跑）没有后端走盘，但内存树自己就知道大小，直接用它的。
  const sizes = useMemo(() => {
    if (!preview) return dirSizes;
    const out: Record<string, DirSize> = {};
    for (const row of rows) {
      if (row.kind === "dir") out[row.path] = { bytes: row.bytes, complete: true };
    }
    return out;
  }, [dirSizes, preview, rows]);

  return {
    preview,
    location,
    rowsToken,
    dirSizes: sizes,
    title: baseName(location),
    pathLabel: location ?? text().files.choosePlace,
    crumbs,
    entries,
    note,
    loadError,
    clip,
    pendingFocus,
    clearPendingFocus: useCallback(() => setPendingFocus(""), []),
    sortKey,
    sortDir,
    chooseSort,
    enter,
    up,
    jump,
    listPlaces,
    stageCopy: (items: FileEntry[]) => stage(items, "copy"),
    stageMove: (items: FileEntry[]) => stage(items, "move"),
    startTransfer,
    paste,
    createDir,
    createFile,
    readText,
    writeText,
    openExternal,
    remove,
    extract,
    compress,
    rename,
    renameMany,
    properties,
    search,
    cancel,
    reload,
    setNote,
  };
}
