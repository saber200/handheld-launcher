/*
 * 任务层与磁盘打交道的那一层：已知目录、列目录、量大小、建目录。
 *
 * 为什么单独一个文件：任务是**纯逻辑**（怎么分组、目标给谁），真正碰盘的动作全在这里，
 * 而且只用现有命令（`file_places` / `file_list` / `file_properties` / `file_make_dir`）。
 * 改造包 §1 的硬约束：除了 `file_thumb`，一个新 Rust 原语都不加。
 */
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../useFileBrowser";
import type { TaskCtx, TaskDirs } from "./types";

/** 把路径末尾的分隔符去掉（`D:\` → `D:`），好做后缀比较。 */
function trimTail(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

export function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  const sep = parent.includes("\\") ? "\\" : "/";
  return `${trimTail(parent)}${sep}${name}`;
}

/** 取父目录；已经是根（`D:\`）就返回空串。 */
export function parentOf(path: string): string {
  const trimmed = trimTail(path);
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (cut < 0) return "";
  const head = trimmed.slice(0, cut + 1);
  // `D:\` 的父目录是它自己：再往上没有了。
  return /^[A-Za-z]:[\\/]$/.test(head) ? head : trimTail(head);
}

/**
 * 把路径按分隔符切开，并挑出盘符/根。
 *
 * 为什么不用 `split(/[\\/]/)` 直接切：`D:\Emulation\ROMs` 切成三段里第一段是 `D:`，
 * 拿它当父目录去 `file_list` 只会报错；建目录时要的是根 `D:\` 作为起点。
 */
export function splitPath(path: string): { root: string; rest: string[] } {
  const trimmed = trimTail(path);
  const drive = /^([A-Za-z]:)[\\/](.*)$/.exec(trimmed);
  if (drive) {
    const tail = drive[2];
    return { root: `${drive[1]}\\`, rest: tail ? tail.split(/[\\/]+/).filter(Boolean) : [] };
  }
  // 非 Windows（本机开发预览）：整条路径都是绝对路径，根就是第一个分隔符之前。
  if (trimmed.startsWith("/")) {
    return { root: "/", rest: trimmed.slice(1).split("/").filter(Boolean) };
  }
  return { root: "", rest: trimmed.split(/[\\/]+/).filter(Boolean) };
}

export function nameOf(path: string): string {
  const trimmed = trimTail(path);
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

/** 盘符（`D:\`）。取不到就空串。 */
export function driveOf(path: string): string {
  return splitPath(path).root;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function listDir(path: string): Promise<FileEntry[]> {
  if (!inTauri()) return [];
  return invoke<FileEntry[]>("file_list", { path });
}

/** 逐级建目录。已存在的层级跳过，不会碰已有内容（`file_make_dir` 只建一层）。 */
async function ensureDir(path: string): Promise<void> {
  const { root, rest } = splitPath(path);
  if (!root) return;
  let current = root;
  for (const segment of rest) {
    let rows: FileEntry[] = [];
    try {
      rows = await listDir(current);
    } catch {
      // 读不了就当不存在，下面的 make_dir 会把真正的错误（权限 / 盘满）报回来。
      rows = [];
    }
    const hit = rows.find(
      (row) => row.kind === "dir" && row.name.toLowerCase() === segment.toLowerCase(),
    );
    if (hit) {
      current = hit.path;
      continue;
    }
    await invoke("file_make_dir", { parent: current, name: segment });
    current = joinPath(current, segment);
  }
}

/** 常用目录。全部由 `file_places` 的真实路径推出来，**不猜盘符也不猜语言**。 */
async function readDirs(places: FileEntry[]): Promise<TaskDirs> {
  const end = (suffix: string) =>
    places.find((row) => trimTail(row.path).toLowerCase().endsWith(suffix.toLowerCase()))?.path ?? "";
  const downloads = end("Downloads");
  const documents = end("Documents");
  const pictures = end("Pictures");
  const desktop = end("Desktop");
  const videos = end("Videos");
  // 家目录：优先拿「下载」的上一级（一定在同一棵树里），其次任何快捷方式。
  const home =
    parentOf(downloads) || parentOf(documents) || parentOf(desktop) || parentOf(pictures) || "";
  // 模拟器 ROM 根与备份根都放在**第一块非系统盘**上：掌机的 C: 通常只有 64–128 GB，
  // ROM 与备份动辄几十 GB。找不到别的盘就退回系统盘（还能用，只是占系统盘空间）。
  const system = places.find((row) => /^[A-Za-z]:[\\/]?$/.test(trimTail(row.path)));
  const other = places.find(
    (row) => /^[A-Za-z]:[\\/]?$/.test(trimTail(row.path)) && !/^c:/i.test(trimTail(row.path)),
  );
  const dataDrive = driveOf(other?.path ?? "") || driveOf(system?.path ?? "") || driveOf(home);
  return {
    home,
    downloads,
    pictures,
    desktop,
    documents,
    // APPDATA / LOCALAPPDATA 不查环境变量（那是 Rust 侧的活）：家目录下就是这两个名字，
    // 拼错了也只是「这一项扫不到」，不会指到别人的目录去。
    roaming: home ? joinPath(home, joinPath("AppData", "Roaming")) : "",
    localAppData: home ? joinPath(home, joinPath("AppData", "Local")) : "",
    myGames: documents ? joinPath(documents, "My Games") : "",
    roms: dataDrive ? joinPath(dataDrive, joinPath("Emulation", "ROMs")) : "",
    backups: dataDrive ? joinPath(dataDrive, joinPath("Backups", "Saves")) : "",
    // 截图：中文 Windows 是「图片\截图」，英文是「图片\Screenshots」；
    // Game Bar 的录屏截帧在「视频\Captures」。三个都给用户挑，不替他猜。
    shots: pictures ? joinPath(pictures, "截图") : videos ? joinPath(videos, "Captures") : "",
  };
}

let cache: { at: number; ctx: TaskCtx } | null = null;

/** 已知目录不常变，但用户可能插拔 U 盘；缓存 10 秒就够了。 */
const CTX_TTL_MS = 10_000;

export async function taskCtx(): Promise<TaskCtx> {
  if (cache && Date.now() - cache.at < CTX_TTL_MS) return cache.ctx;
  const places = inTauri() ? await invoke<FileEntry[]>("file_places") : [];
  const dirs = await readDirs(places);
  const ctx: TaskCtx = {
    dirs,
    list: listDir,
    async measure(path) {
      if (!inTauri()) return { bytes: 0, complete: false };
      const props = await invoke<{ bytes: number; sizeComplete: boolean }>("file_properties", {
        path,
      });
      return { bytes: props.bytes, complete: props.sizeComplete };
    },
    async drives() {
      if (!inTauri()) return [];
      const rows = await invoke<FileEntry[]>("file_places");
      return rows.filter((row) => /^[A-Za-z]:[\\/]?$/.test(trimTail(row.path)));
    },
    makeDir: ensureDir,
    async games() {
      if (!inTauri()) return [];
      try {
        const rows = await invoke<{ name: string; installPath: string }[]>("scan_games");
        return rows
          .filter((row) => row.installPath)
          .map((row) => ({ name: row.name, installPath: row.installPath }));
      } catch {
        // 游戏库扫不动（注册表被锁之类）不该把整个任务卡住：当作「一台游戏都没装」，
        // 用户仍然可以自己挑目标目录。
        return [];
      }
    },
  };
  cache = { at: Date.now(), ctx };
  return ctx;
}

/**
 * 可移动盘 / U 盘。
 *
 * 为什么只能这么判：`file_places` 只给盘符，没有盘类型（那要新命令，改造包不允许）。
 * 系统盘一定是 C:，所以「不是 C: 的盘」就是候选 —— 掌机上这个判断基本都成立
 * （单盘掌机 + 插 U 盘 / SD 卡）；用户自己分了个 D: 数据区时，
 * 把它列出来也不误导：它确实是一个可以往里放东西的盘。
 */
export async function externalDrives(ctx: TaskCtx): Promise<FileEntry[]> {
  const all = await ctx.drives();
  return all.filter((row) => !/^c:$/i.test(trimTail(row.path)));
}

/** 文件大小 → 「8.4 GB」。和文件页的 `formatBytes` 口径一致。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTime(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

/**
 * 秒 → 「约 40 秒 / 约 3 分 20 秒 / 约 1.2 小时」。
 *
 * 文案由调用方从 i18n 传进来（`{n}` / `{m}` / `{s}` 占位）：这个函数在任务层，
 * 拿 `text()` 会把它和 i18n 模块绑死，任务层就不好单独测了。
 */
export function formatEta(
  seconds: number,
  template: { sec: string; min: string; hour: string },
): string {
  if (seconds <= 0) return "";
  if (seconds < 90) return template.sec.replace("{n}", String(Math.max(1, Math.round(seconds))));
  if (seconds < 5400) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return template.min.replace("{m}", String(minutes)).replace("{s}", String(rest));
  }
  return template.hour.replace("{n}", (seconds / 3600).toFixed(1));
}
