import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playSfx, startLoadingSfx, stopLoadingSfx } from "../audio/sfx";
import { PREVIEW_APPS, type AppEntry } from "../data/previewApps";
import { PREVIEW_GAMES, type GameEntry } from "../data/previewGames";
import { parentPath } from "../files/useFileBrowser";
import { currentLocale, text } from "../i18n";
import { recordLaunch } from "./recent";
import { resetModProgress } from "./useModProgress";

const APP_COLORS = [
  "#1b2838",
  "#0f766e",
  "#1d4e89",
  "#3c3489",
  "#146c43",
  "#2a2a2a",
  "#107c10",
  "#1e3a5f",
  "#1a7f37",
  "#8a5a00",
  "#1f2937",
  "#243056",
];

type RawGame = {
  id: string;
  name: string;
  cover: string;
  coverPath: string;
  installPath: string;
  launchPath: string;
  sizeBytes?: number;
  playtimeMinutes?: number;
};

type RawApp = {
  id: string;
  name: string;
  iconPath: string;
  installPath: string;
  launchPath: string;
  version?: string;
  sizeBytes?: number;
  /** 注册表 `InstallDate`（`YYYYMMDD`）。空 = 安装器没写，界面就不拿它排序。 */
  installDate?: string;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let launching = false;
let installingMods = false;

export async function launchLibraryItem(item: {
  id: string;
  name: string;
  launchPath?: string;
  installPath?: string;
  customPath?: boolean;
  switchIfRunning?: boolean;
  /** 游戏还是软件：首页的「继续游玩」只排游戏（软件走「最近安装的软件」那一条）。 */
  kind?: "game" | "app";
}): Promise<string> {
  if (!inTauri()) {
    return text().library.previewLaunch;
  }
  if (launching) return text().library.launching;
  launching = true;
  try {
    const outcome = await invoke<string>("launch_item", {
      id: item.customPath ? `file:${item.id}` : item.id,
      launchPath: item.launchPath ?? "",
      installPath: item.installPath ?? "",
      switchIfRunning: item.switchIfRunning ?? false,
    });
    // 记一笔「刚刚启动过」：首页的「继续游玩」就靠它（见 library/recent.ts）。
    // 只在**真的动手启动**之后记 —— 前置失败（找不到 exe）不该出现在首页上。
    recordLaunch({
      id: item.id,
      name: item.name,
      kind: item.kind ?? "game",
      installPath: item.installPath,
      launchPath: item.launchPath,
    });
    playSfx("done");
    if (outcome === "focused") return text().library.switched(item.name);
    if (outcome === "running") return text().library.alreadyRunning(item.name);
    return text().library.launched(item.name);
  } catch (err) {
    return text().library.launchFailed(item.name, formatError(err));
  } finally {
    launching = false;
  }
}

export async function quitLibraryGame(item: {
  id: string;
  name: string;
  launchPath?: string;
  installPath?: string;
  customPath?: boolean;
}): Promise<string> {
  if (!inTauri()) {
    return text().library.previewLaunch;
  }
  try {
    await invoke<number>("quit_game", {
      id: item.customPath ? `file:${item.id}` : item.id,
      launchPath: item.launchPath ?? "",
      installPath: item.installPath ?? "",
    });
    return text().library.quitGameDone(item.name);
  } catch (err) {
    const detail = formatError(err);
    if (detail.includes("没有找到") || detail.toLowerCase().includes("no running")) {
      return text().library.quitGameNotRunning(item.name);
    }
    return text().library.quitGameFailed(item.name, detail);
  }
}

/** Rust 侧 `toolbox.rs::OptiScalerStatus` 的形状。 */
export type ModStatus = {
  dir: string | null;
  installed: boolean;
  version: string | null;
  hook: string | null;
  legacy: boolean;
  /** 目录里已存在、但不是我们装的同名 DLL（游戏自带的 dxgi.dll 这类）。 */
  conflict: string | null;
  /** 主程序不是 x64 时的文件名：装进去游戏会起不来。 */
  arch: string | null;
  running: boolean;
  hooks: string[];
  message: string;
};

export type ModTarget = {
  name: string;
  launchPath?: string;
  installPath?: string;
};

export type ModVersion = {
  version: string;
  /** GitHub 上的标签（`v0.9.4`）：安装时按它去查具体那个 release。 */
  tag: string;
  bytes: number;
  latest: boolean;
};

export const DEFAULT_MOD_HOOK = "dxgi.dll";

/** 能装的版本列表（最近的几个）。拿不到就空数组，界面按「装最新」走。 */
export async function modVersions(): Promise<ModVersion[]> {
  if (!inTauri()) return [];
  try {
    return await invoke<ModVersion[]>("toolbox_optiscaler_versions");
  } catch {
    return [];
  }
}

/**
 * 安装前的状态：装哪儿、装了没有、会不会冲突。
 *
 * 必须把 `installPath` 一起给 Rust：Steam 游戏的 `launchPath` 是 `steam://rungameid/…`
 * 这类地址，只有它的话后端算不出游戏目录（老实现就是这么报「游戏目录无效」的）。
 */
export async function modStatus(item: ModTarget, hook?: string): Promise<ModStatus | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<ModStatus>("toolbox_optiscaler_status", {
      launchPath: item.launchPath ?? "",
      installPath: item.installPath ?? "",
      hook: hook ?? null,
    });
  } catch {
    // 状态查不到不该挡路：面板会退回「按默认值装」这条路，真正的报错在安装时给。
    return null;
  }
}

/** Card menu → 安装 Mod / 工具: drop OptiScaler next to the game executable. */
export async function installLibraryGameMods(
  item: ModTarget,
  hook: string = DEFAULT_MOD_HOOK,
  version?: string,
): Promise<string> {
  if (!inTauri()) {
    return text().library.installModsPreview;
  }
  if (!item.launchPath && !item.installPath) return text().library.installModsNoPath;
  if (installingMods) return text().library.installModsBusy;
  installingMods = true;
  resetModProgress();
  try {
    const message = await invoke<string>("toolbox_install_optiscaler", {
      launchPath: item.launchPath ?? "",
      installPath: item.installPath ?? "",
      hook,
      // 空 = 装最新（后端按 latest 查）。
      version: version ?? null,
    });
    playSfx("done");
    return text().library.installModsResult(item.name, message);
  } catch (err) {
    return text().library.installModsFailed(item.name, formatError(err));
  } finally {
    installingMods = false;
  }
}

/** 卸载并把被覆盖的原文件还原（靠游戏目录里的安装账本）。 */
export async function uninstallLibraryGameMods(item: ModTarget): Promise<string> {
  if (!inTauri()) return text().library.installModsPreview;
  if (!item.launchPath && !item.installPath) return text().library.installModsNoPath;
  try {
    const message = await invoke<string>("toolbox_uninstall_optiscaler", {
      launchPath: item.launchPath ?? "",
      installPath: item.installPath ?? "",
    });
    playSfx("done");
    return text().library.uninstallModsResult(item.name, message);
  } catch (err) {
    return text().library.uninstallModsFailed(item.name, formatError(err));
  }
}

/** 「取消安装」按钮：只翻一个开关，Rust 在下载循环里看到它就收尾。 */
export async function cancelLibraryGameMods(): Promise<void> {
  if (!inTauri()) return;
  try {
    await invoke("toolbox_cancel_mod");
  } catch {
    /* 没在装的时候点它什么也不用做 */
  }
}

export function useRunningGameIds(items: { id: string; launchPath?: string; installPath?: string }[]) {
  const [ids, setIds] = useState<string[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const key = items.map((item) => `${item.id}\n${item.launchPath ?? ""}\n${item.installPath ?? ""}`).join("\n");
  useEffect(() => {
    if (!inTauri() || key.length === 0) {
      setIds((current) => (current.length === 0 ? current : []));
      return;
    }
    let cancel = false;
    let inFlight = false;
    const tick = () => {
      // The probe walks the process list: never stack a second one behind a
      // slow answer, that is how quick tab-hopping used to pile up work.
      if (inFlight) return;
      inFlight = true;
      void invoke<string[]>("running_games", {
        items: itemsRef.current.map((item) => ({
          id: item.id,
          launchPath: item.launchPath ?? "",
          installPath: item.installPath ?? "",
        })),
      })
        .then((next) => {
          if (cancel) return;
          setIds((current) =>
            current.length === next.length && current.every((id, index) => id === next[index]) ? current : next,
          );
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, 1500);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [key]);
  return new Set(ids);
}

export type RunningLibraryGame = {
  id: string;
  name: string;
  launchPath?: string;
  installPath?: string;
  customPath?: boolean;
};

/** Result of one process probe: the game found, and whether an answer arrived. */
export type RunningProbe = {
  game: RunningLibraryGame | null;
  /** False until the current probe session got a usable answer (empty counts). */
  settled: boolean;
};

/**
 * 「游戏目录 → 封面」表，给**文件页**的预览面板用（FUTURE.md 功能 15 第 5 条）。
 *
 * 两条设计约束，都是踩过的：
 *   1. **只读缓存，从不触发扫描**。文件页的预览是「焦点一动就更新」的，这里挂一次
 *      全盘扫描，等于用户每进一个新目录就等几十秒。缓存里没有就返回 null ——
 *      预览少一张封面，比整页卡住强得多。
 *   2. 只用**这一层已有的** `installPath` 对齐，不猜「这个目录看起来像游戏」：
 *      拿不到就什么都不显示（目录预览仍然有子项数与大小）。
 */
export function gameCoverFor(dirPath: string): { name: string; cover: string } | null {
  if (!inTauri() || !dirPath) return null;
  const key = normalizeDirKey(dirPath);
  const rows = readScanCache<RawGame>("scan_games") ?? [];
  for (const row of rows) {
    if (!row.coverPath || !row.installPath) continue;
    if (normalizeDirKey(row.installPath) !== key) continue;
    return { name: row.name, cover: convertFileSrc(row.coverPath) };
  }
  // 手动添加的游戏（extras）没有 coverPath，也就没有封面可显示 —— 不猜。
  return null;
}

/** 比路径时统一大小写与结尾分隔符（Windows 上两者都会变，不统一就永远比不上）。 */
function normalizeDirKey(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * 已装软件（从这一层的扫描缓存里读，**不触发扫描**）—— 首页「最近安装的软件」用它。
 *
 * 和 `cachedLibraryGames` 同一个理由：首页一挂载就要出内容，不能等一次全盘扫描。
 * 按 `installDate` 倒序排（注册表里那一列），没写日期的排后面、按名字排。
 */
export function cachedApps(): { id: string; name: string; version: string; sizeBytes: number; installDate: string }[] {
  if (!inTauri()) return [];
  const rows = readScanCache<RawApp>("scan_apps") ?? [];
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      version: (row.version ?? "").trim(),
      sizeBytes: row.sizeBytes ?? 0,
      installDate: (row.installDate ?? "").trim(),
    }))
    .sort((a, b) => {
      if (a.installDate !== b.installDate) return b.installDate.localeCompare(a.installDate);
      return a.name.localeCompare(b.name, currentLocale());
    });
}

/**
 * The games the library would show, read straight from this session's scan
 * cache. The frontend overlay only needs a candidate list for `running_games`;
 * unlike the library page it must never start a full system scan.
 */
export function cachedLibraryGames(): RunningLibraryGame[] {
  if (!inTauri()) return [];
  const extras = loadExtras("games");
  const scanned = (readScanCache<RawGame>("scan_games") ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    launchPath: row.launchPath,
    installPath: row.installPath,
  }));
  const base = withPaths(scanned, extras);
  const known = new Set(base.map((item) => item.launchPath).filter(Boolean));
  const added = extras.added
    .filter((item) => !known.has(item.launchPath))
    .map((item) => ({
      id: item.id,
      name: item.name,
      launchPath: item.launchPath,
      installPath: item.installPath,
      customPath: true,
    }));
  return [...base, ...added].filter((item) => !extras.hidden.includes(item.id));
}

/**
 * The library game running right now, for the frontend's quit row. Probes the
 * same process list as the library, but only while the overlay is on screen.
 * Returns `null` for apps and for the shell itself, so no row is offered there.
 */
export function useRunningLibraryGame(active: boolean): [RunningProbe, () => void] {
  const [probe, setProbe] = useState<RunningProbe>({ game: null, settled: false });
  const items = useMemo(() => (active ? cachedLibraryGames() : []), [active]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const probes = useRef<() => void>(() => {});
  const tick = useCallback(() => {
    const list = itemsRef.current;
    if (list.length === 0) {
      setProbe({ game: null, settled: true });
      return;
    }
    // Walking the process list is the expensive part: never stack a second probe,
    // but remember the ask — a quit has to land without waiting for the next tick.
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    void invoke<string[]>("running_games", {
      items: list.map((item) => ({
        id: item.id,
        launchPath: item.launchPath ?? "",
        installPath: item.installPath ?? "",
      })),
    })
      .then((ids) =>
        setProbe({ game: list.find((item) => ids.includes(item.id)) ?? null, settled: true }),
      )
      // A probe that failed is not a game that quit: leave the last answer alone.
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
        if (rerun.current) {
          rerun.current = false;
          probes.current();
        }
      });
  }, []);
  probes.current = tick;
  useEffect(() => {
    if (!active || !inTauri()) {
      setProbe({ game: null, settled: false });
      return;
    }
    tick();
    const timer = window.setInterval(tick, 4000);
    return () => window.clearInterval(timer);
  }, [active, tick]);
  return [probe, tick];
}

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return err.message;
  return text().library.failed;
}

/**
 * 扫描结果缓存的键。**`v2` 是 2026-10-04 加的**：那一版给扫描结果加了「体积 / 时长 / 版本」
 * 三个字段，而 localStorage 里存的还是老结构（没有这三个字段）—— 不改键的话，升级后
 * 界面会一直用老缓存、卡片和面板上的新数据永远是空的（用户会当成坏了），要他自己点
 * 「重新扫描」才恢复。加个版本号让老缓存直接作废，升级后第一次进库自然重扫一次。
 * 以后**改扫描结果的结构就把它 +1**。
 */
function scanCacheKey(command: string) {
  return `handheld-launcher.scan.v2.${command}`;
}

function scanStampKey(command: string) {
  return `handheld-launcher.scan.v2.${command}.checked`;
}

/// How long a finished scan counts as "already followed up". Covers and icons
/// are fetched over the network, so a tab switch must not start that again.
const SCAN_FOLLOW_UP_MS = 10 * 60 * 1000;

function scanCheckedAt(command: string): number {
  try {
    const raw = localStorage.getItem(scanStampKey(command));
    const value = raw == null ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function markScanChecked(command: string) {
  try {
    localStorage.setItem(scanStampKey(command), String(Date.now()));
  } catch {
    // Storage full / disabled: the next mount just tries again.
  }
}

const scanMemory = new Map<string, unknown[]>();
const pendingScans = new Map<string, Promise<unknown[]>>();

function readScanCache<TRaw>(command: string): TRaw[] | null {
  const memory = scanMemory.get(command);
  if (memory) return memory as TRaw[];
  try {
    const raw = localStorage.getItem(scanCacheKey(command));
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as TRaw[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeScanCache<TRaw>(command: string, rows: TRaw[]) {
  scanMemory.set(command, rows);
  try {
    localStorage.setItem(scanCacheKey(command), JSON.stringify(rows));
  } catch {
    // A full / disabled persistent cache must not discard a successful scan.
  }
}

function requestScan<TRaw>(command: string): Promise<TRaw[]> {
  const pending = pendingScans.get(command);
  if (pending) return pending as Promise<TRaw[]>;
  if (pendingScans.size === 0) startLoadingSfx();
  let succeeded = false;
  const request = invoke<TRaw[]>(command)
    .then((rows) => {
      writeScanCache(command, rows);
      succeeded = true;
      return rows;
    })
    .finally(() => {
      pendingScans.delete(command);
      // Sound belongs to the shared request, not to a page that can unmount.
      if (pendingScans.size === 0) stopLoadingSfx(succeeded);
      else if (succeeded) playSfx("done");
    });
  pendingScans.set(command, request);
  return request;
}

function useScanned<TRaw, T extends { name: string }>(
  command: string,
  preview: T[],
  notes: {
    preview: string;
    scanning: string;
    empty: string;
    ready: (count: number) => string;
  },
  map: (row: TRaw) => T,
  afterLoad?: (items: T[], update: (next: T[]) => void) => void,
): { items: T[]; note: string; scanning: boolean; rescan: () => void } {
  const native = inTauri();
  const [items, setItems] = useState<T[] | null>(() => {
    if (!native) return null;
    const cached = readScanCache<TRaw>(command);
    if (!cached) return null;
    return cached.map(map).sort((a, b) => a.name.localeCompare(b.name, currentLocale()));
  });
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const activeScan = useRef<{ current: boolean } | null>(null);

  const finish = useCallback(
    (rows: TRaw[], cancel: { current: boolean }) => {
      if (cancel.current) return;
      const next = rows.map(map).sort((a, b) => a.name.localeCompare(b.name, currentLocale()));
      setItems(next);
      setError("");
      markScanChecked(command);
      afterLoad?.(next, (updated) => {
        if (!cancel.current) setItems(updated);
      });
    },
    [afterLoad, command, map],
  );

  const run = useCallback(
    (cancel: { current: boolean }) => {
      if (activeScan.current && activeScan.current !== cancel) activeScan.current.current = true;
      activeScan.current = cancel;
      setScanning(true);
      setError("");
      void requestScan<TRaw>(command)
        .then((rows) => finish(rows, cancel))
        .catch((err: unknown) => {
          if (!cancel.current) setError(formatError(err));
        })
        .finally(() => {
          if (!cancel.current) setScanning(false);
        });
    },
    [command, finish],
  );

  useEffect(() => {
    if (!native) return;
    const cached = readScanCache<TRaw>(command);
    const cancel = { current: false };
    activeScan.current = cancel;
    const cleanup = () => {
      cancel.current = true;
      if (activeScan.current) activeScan.current.current = true;
      activeScan.current = null;
    };
    // Rejoin a manual scan too, even when an older cache is already available.
    if (pendingScans.has(command)) {
      run(cancel);
      return cleanup;
    }
    if (cached) {
      const mapped = cached.map(map).sort((a, b) => a.name.localeCompare(b.name, currentLocale()));
      setItems(mapped);
      setScanning(false);
      // Cached rows already carry the covers/icons a previous follow-up saved.
      // Only redo that work when it is stale — switching tabs must not re-fetch
      // every missing cover (each one waits out its own network timeout).
      if (Date.now() - scanCheckedAt(command) >= SCAN_FOLLOW_UP_MS) {
        markScanChecked(command);
        afterLoad?.(mapped, (updated) => {
          if (!cancel.current) setItems(updated);
        });
      }
      return cleanup;
    }
    run(cancel);
    return cleanup;
  }, [afterLoad, command, map, native, run]);

  const rescan = useCallback(() => {
    if (!native) return;
    run({ current: false });
  }, [native, run]);

  if (!native) return { items: preview, note: notes.preview, scanning: false, rescan };
  if (scanning && items && items.length > 0) {
    return { items, note: text().library.rescanning, scanning, rescan };
  }
  if (error) return { items: items ?? [], note: text().library.scanFailed(error), scanning, rescan };
  if (!items || scanning) return { items: items ?? [], note: notes.scanning, scanning: true, rescan };
  if (items.length === 0) return { items: [], note: notes.empty, scanning, rescan };
  return { items, note: notes.ready(items.length), scanning, rescan };
}

function displayCover(row: RawGame): string {
  if (row.coverPath) return convertFileSrc(row.coverPath);
  return row.cover;
}

function remoteCoverFor(row: RawGame): string | undefined {
  if (row.cover.startsWith("https://")) return row.cover;
  const steam = row.id.match(/^steam:(\d+)$/);
  if (steam) return steamLibraryCover(steam[1]);
  return undefined;
}

function mapGame(row: RawGame): GameEntry {
  return {
    id: row.id,
    name: row.name,
    cover: displayCover(row),
    coverRemote: remoteCoverFor(row),
    installPath: row.installPath,
    launchPath: row.launchPath,
    // 老缓存里没有这两项（更新前扫的库）→ undefined = 不知道，界面不画那一格。
    sizeBytes: row.sizeBytes && row.sizeBytes > 0 ? row.sizeBytes : undefined,
    playtimeMinutes: row.playtimeMinutes && row.playtimeMinutes > 0 ? row.playtimeMinutes : undefined,
  };
}

function cacheMissingCovers(items: GameEntry[], update: (next: GameEntry[]) => void) {
  const pending = items.filter((game) => {
    const remote = game.coverRemote ?? (game.cover.startsWith("https://") ? game.cover : "");
    return remote.startsWith("https://");
  });
  if (pending.length === 0) return;
  void invoke<Array<{ id: string; coverPath: string }>>("cache_covers", {
    covers: pending.map((game) => ({
      id: game.id,
      url: game.coverRemote ?? game.cover,
    })),
  })
    .then((saved) => {
      if (saved.length === 0) return;
      const paths = new Map(saved.map((item) => [item.id, item.coverPath]));
      const cached = readScanCache<RawGame>("scan_games");
      if (cached) {
        writeScanCache(
          "scan_games",
          cached.map((row) => {
            const path = paths.get(row.id);
            // Keep the HTTPS URL so upgrades / missing files can fall back.
            return path ? { ...row, coverPath: path } : row;
          }),
        );
      }
      update(
        items.map((game) => {
          const path = paths.get(game.id);
          if (!path) return game;
          const remote =
            game.coverRemote ??
            (game.cover.startsWith("https://") ? game.cover : undefined);
          return {
            ...game,
            cover: convertFileSrc(path),
            coverRemote: remote,
          };
        }),
      );
    })
    .catch(() => {});
}

function programMark(name: string) {
  const text = name.trim();
  const first = Array.from(text)[0] ?? "?";
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { mark: first.toUpperCase(), color: APP_COLORS[hash % APP_COLORS.length] };
}

function mapApp(row: RawApp): AppEntry {
  return {
    id: row.id,
    name: row.name,
    ...programMark(row.name),
    icon: row.iconPath ? convertFileSrc(row.iconPath) : undefined,
    installPath: row.installPath,
    launchPath: row.launchPath,
    version: row.version?.trim() ? row.version.trim() : undefined,
    sizeBytes: row.sizeBytes && row.sizeBytes > 0 ? row.sizeBytes : undefined,
    installDate: row.installDate?.trim() ? row.installDate.trim() : undefined,
  };
}

export type PickedProgram = { name: string; path: string };

type ExtraItem = {
  id: string;
  name: string;
  launchPath: string;
  installPath: string;
  iconPath?: string;
};

type CoverExtra = { appId: string; coverPath?: string; coverUrl?: string };

type Extras = {
  added: ExtraItem[];
  paths: Record<string, { launchPath: string; installPath: string }>;
  hidden: string[];
  covers: Record<string, CoverExtra>;
};

function emptyExtras(): Extras {
  return { added: [], paths: {}, hidden: [], covers: {} };
}

function steamLibraryCover(appId: string) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
}

function libraryAssetOk(name: string) {
  const file = name.split("/").pop() ?? "";
  if (!["library_capsule.jpg", "library_capsule_2x.jpg", "library_600x900.jpg", "library_600x900_2x.jpg"].includes(file)) {
    return false;
  }
  return name.split("/").every((part) => part.length > 0 && /^[A-Za-z0-9_.]+$/.test(part));
}

function coverFromAssets(assets: {
  asset_url_format?: string;
  library_capsule?: string;
  library_capsule_2x?: string;
}) {
  const format = assets.asset_url_format ?? "";
  const file = [assets.library_capsule, assets.library_capsule_2x].find((name) => name && libraryAssetOk(name));
  if (!file || !format.startsWith("steam/apps/") || !format.includes("${FILENAME}")) return "";
  const appId = format.slice("steam/apps/".length).split("/")[0] ?? "";
  if (!/^\d{1,10}$/.test(appId)) return "";
  const path = format.replace("${FILENAME}", file);
  if (path.includes("..")) return "";
  return `https://shared.akamai.steamstatic.com/store_item_assets/${path}`;
}

async function resolveSteamLibraryCover(appId: string) {
  if (inTauri()) {
    return invoke<string>("steam_library_cover", { appId });
  }
  const input = {
    ids: [{ appid: Number(appId) }],
    context: { language: "english", country_code: "US", steam_realm: 1 },
    data_request: { include_assets: true },
  };
  const response = await fetch(
    `/steam-api/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`,
  );
  if (!response.ok) throw new Error("missing");
  const data = (await response.json()) as {
    response?: { store_items?: Array<{ assets?: Parameters<typeof coverFromAssets>[0] }> };
  };
  const url = coverFromAssets(data.response?.store_items?.[0]?.assets ?? {});
  if (!url) throw new Error("missing");
  return url;
}

function loadCovers(value: unknown): Record<string, CoverExtra> {
  if (!value || typeof value !== "object") return {};
  const covers: Record<string, CoverExtra> = {};
  for (const [id, row] of Object.entries(value as Record<string, unknown>)) {
    if (!row || typeof row !== "object") continue;
    const appId = (row as { appId?: unknown }).appId;
    const coverPath = (row as { coverPath?: unknown }).coverPath;
    const coverUrl = (row as { coverUrl?: unknown }).coverUrl;
    if (typeof appId !== "string" || !/^\d{1,10}$/.test(appId)) continue;
    covers[id] = {
      appId,
      ...(typeof coverPath === "string" && coverPath ? { coverPath } : {}),
      ...(typeof coverUrl === "string" && coverUrl.startsWith("https://") ? { coverUrl } : {}),
    };
  }
  return covers;
}

function loadExtras(kind: "games" | "apps"): Extras {
  try {
    const raw = localStorage.getItem(`handheld-launcher.files.${kind}`);
    if (!raw) return emptyExtras();
    const parsed = JSON.parse(raw) as Partial<Extras>;
    return {
      added: Array.isArray(parsed.added) ? parsed.added : [],
      paths: parsed.paths && typeof parsed.paths === "object" ? parsed.paths : {},
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((id) => typeof id === "string") : [],
      covers: loadCovers(parsed.covers),
    };
  } catch {
    return emptyExtras();
  }
}

function programName(fileName: string) {
  const withoutExe = fileName.replace(/\.exe$/i, "");
  if (withoutExe !== fileName && withoutExe.trim()) return withoutExe.trim();
  const dot = fileName.lastIndexOf(".");
  if (dot > 0) return fileName.slice(0, dot);
  return fileName;
}

function useLibraryExtras(kind: "games" | "apps") {
  const [extras, setExtras] = useState<Extras>(() => loadExtras(kind));

  useEffect(() => {
    localStorage.setItem(`handheld-launcher.files.${kind}`, JSON.stringify(extras));
  }, [extras, kind]);

  const add = useCallback(
    (file: PickedProgram) => {
      const name = programName(file.name);
      const launchPath = file.path;
      const installPath = parentPath(file.path) ?? "";
      const id = `local:${kind}:${Date.now()}`;
      setExtras((prev) => ({
        ...prev,
        hidden: prev.hidden.filter((item) => item !== id),
        added: [...prev.added, { id, name, launchPath, installPath }],
      }));
      if (kind === "apps" && inTauri()) {
        void invoke<string>("file_icon", { path: launchPath })
          .then((iconPath) => {
            if (!iconPath) return;
            setExtras((prev) => ({
              ...prev,
              added: prev.added.map((item) => (item.id === id ? { ...item, iconPath } : item)),
            }));
          })
          .catch(() => {});
      }
      return text().library.added(name);
    },
    [kind],
  );

  const setLaunchPath = useCallback((id: string, file: PickedProgram) => {
    const launchPath = file.path;
    const installPath = parentPath(file.path) ?? "";
    const name = programName(file.name);
    setExtras((prev) => ({
      ...prev,
      paths: { ...prev.paths, [id]: { launchPath, installPath } },
      added: prev.added.map((item) => (item.id === id ? { ...item, launchPath, installPath } : item)),
    }));
    return text().library.pathUpdated(name);
  }, []);

  const hide = useCallback((id: string) => {
    setExtras((prev) => ({
      ...prev,
      hidden: prev.hidden.includes(id) ? prev.hidden : [...prev.hidden, id],
    }));
    return text().library.hidden;
  }, []);

  const restore = useCallback((id: string) => {
    setExtras((prev) => ({
      ...prev,
      hidden: prev.hidden.filter((item) => item !== id),
    }));
    return text().library.restored;
  }, []);

  const setCover = useCallback((id: string, appId: string, coverPath?: string, coverUrl?: string) => {
    setExtras((prev) => ({
      ...prev,
      covers: {
        ...prev.covers,
        [id]: {
          appId,
          ...(coverPath ? { coverPath } : {}),
          ...(coverUrl ? { coverUrl } : {}),
        },
      },
    }));
  }, []);

  return { extras, add, setLaunchPath, hide, restore, setCover };
}

function withPaths<T extends { id: string; launchPath?: string; installPath?: string; customPath?: boolean }>(
  items: T[],
  extras: Extras,
): T[] {
  return items.map((item) => {
    const path = extras.paths[item.id];
    if (!path) return item;
    return { ...item, launchPath: path.launchPath, installPath: path.installPath, customPath: true };
  });
}

function libraryNote(scannedCount: number, shownCount: number, hiddenCount: number, scannedNote: string) {
  if (shownCount === 0 && hiddenCount > 0) return text().library.allHidden;
  if (scannedCount === 0 && shownCount > 0) return text().library.onlyAdded(shownCount);
  return scannedNote;
}

export function useLocalGames() {
  const scanned = useScanned("scan_games", PREVIEW_GAMES, {
    preview: text().library.gamesPreview,
    scanning: text().library.gamesScanning,
    empty: text().library.gamesEmpty,
    ready: (count) => text().library.gamesReady(count),
  }, mapGame, cacheMissingCovers);
  const extra = useLibraryExtras("games");
  const items = useMemo(() => {
    const base = withPaths(scanned.items, extra.extras);
    const known = new Set(base.map((item) => item.launchPath).filter(Boolean));
    const added = extra.extras.added
      .filter((item) => !known.has(item.launchPath))
      .map((item) => ({
        id: item.id,
        name: item.name,
        cover: "",
        launchPath: item.launchPath,
        installPath: item.installPath,
        customPath: true,
      }));
    return [...base, ...added]
      .map((item) => {
        const saved = extra.extras.covers[item.id];
        if (!saved) return item;
        const remote = saved.coverUrl || steamLibraryCover(saved.appId);
        const cover =
          saved.coverPath && inTauri() ? convertFileSrc(saved.coverPath) : remote;
        return { ...item, cover, coverRemote: remote };
      })
      .filter((item) => !extra.extras.hidden.includes(item.id))
      .sort((a, b) => a.name.localeCompare(b.name, currentLocale()));
  }, [extra.extras, scanned.items]);
  // 把游戏清单发布到 `library.json`：独立前端读这个文件来判断「哪个游戏在跑 / 退掉它」。
  // 前端读的是**数据文件**，不是命令通道 —— 启动器不因此获得任何对前端的控制能力
  // （见仓库根 FRONTEND.md §3/§4）。
  useEffect(() => {
    if (!inTauri()) return;
    void invoke("library_publish", {
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        launchPath: item.launchPath ?? "",
        installPath: item.installPath ?? "",
      })),
    }).catch(() => {});
  }, [items]);

  const restorable = useMemo(() => {
    const hidden = new Set(extra.extras.hidden);
    if (hidden.size === 0) return [];
    const base = withPaths(scanned.items, extra.extras);
    const known = new Set(base.map((item) => item.launchPath).filter(Boolean));
    const added = extra.extras.added
      .filter((item) => !known.has(item.launchPath))
      .map((item) => ({
        id: item.id,
        name: item.name,
        cover: "",
        launchPath: item.launchPath,
        installPath: item.installPath,
        customPath: true,
      }));
    return [...base, ...added]
      .map((item) => {
        const saved = extra.extras.covers[item.id];
        if (!saved) return item;
        const remote = saved.coverUrl || steamLibraryCover(saved.appId);
        const cover =
          saved.coverPath && inTauri() ? convertFileSrc(saved.coverPath) : remote;
        return { ...item, cover, coverRemote: remote };
      })
      .filter((item) => hidden.has(item.id))
      .sort((a, b) => a.name.localeCompare(b.name, currentLocale()));
  }, [extra.extras, scanned.items]);
  const addFromFile = useCallback(
    (file: PickedProgram) => {
      if (items.some((item) => item.launchPath === file.path)) return text().library.alreadyInLibrary;
      return extra.add(file);
    },
    [extra, items],
  );
  const setSteamCover = useCallback(
    async (id: string, appId: string) => {
      const digits = appId.trim();
      if (!/^\d{1,10}$/.test(digits)) return text().library.steamDigits;
      let url = "";
      try {
        url = await resolveSteamLibraryCover(digits);
      } catch {
        return text().library.steamMissing;
      }
      extra.setCover(id, digits, undefined, url);
      if (inTauri()) {
        try {
          const saved = await invoke<Array<{ id: string; coverPath: string }>>("cache_covers", {
            covers: [{ id, url }],
          });
          const coverPath = saved.find((row) => row.id === id)?.coverPath;
          if (coverPath) extra.setCover(id, digits, coverPath, url);
        } catch {
          /* 网络封面仍可显示，下次再缓存 */
        }
      }
      return text().library.steamApplied(digits);
    },
    [extra],
  );
  return {
    items,
    restorable,
    note: scanned.scanning
      ? scanned.note
      : libraryNote(scanned.items.length, items.length, extra.extras.hidden.length, scanned.note),
    scanning: scanned.scanning,
    rescan: () => {
      if (!inTauri()) return text().library.previewNoScan;
      scanned.rescan();
      return "";
    },
    addFromFile,
    setLaunchPath: extra.setLaunchPath,
    hide: extra.hide,
    restore: extra.restore,
    setSteamCover,
  };
}

export function useLocalApps() {
  const scanned = useScanned("scan_apps", PREVIEW_APPS, {
    preview: text().library.appsPreview,
    scanning: text().library.appsScanning,
    empty: text().library.appsEmpty,
    ready: (count) => text().library.appsReady(count),
  }, mapApp);
  const extra = useLibraryExtras("apps");
  const items = useMemo(() => {
    const base = withPaths(scanned.items, extra.extras);
    const known = new Set(base.map((item) => item.launchPath).filter(Boolean));
    const added = extra.extras.added
      .filter((item) => !known.has(item.launchPath))
      .map((item) => ({
        id: item.id,
        name: item.name,
        ...programMark(item.name),
        icon: item.iconPath && inTauri() ? convertFileSrc(item.iconPath) : undefined,
        launchPath: item.launchPath,
        installPath: item.installPath,
        customPath: true,
      }));
    return [...base, ...added]
      .filter((item) => !extra.extras.hidden.includes(item.id))
      .sort((a, b) => a.name.localeCompare(b.name, currentLocale()));
  }, [extra.extras, scanned.items]);
  const restorable = useMemo(() => {
    const hidden = new Set(extra.extras.hidden);
    if (hidden.size === 0) return [];
    const base = withPaths(scanned.items, extra.extras);
    const known = new Set(base.map((item) => item.launchPath).filter(Boolean));
    const added = extra.extras.added
      .filter((item) => !known.has(item.launchPath))
      .map((item) => ({
        id: item.id,
        name: item.name,
        ...programMark(item.name),
        icon: item.iconPath && inTauri() ? convertFileSrc(item.iconPath) : undefined,
        launchPath: item.launchPath,
        installPath: item.installPath,
        customPath: true,
      }));
    return [...base, ...added]
      .filter((item) => hidden.has(item.id))
      .sort((a, b) => a.name.localeCompare(b.name, currentLocale()));
  }, [extra.extras, scanned.items]);
  const addFromFile = useCallback(
    (file: PickedProgram) => {
      if (items.some((item) => item.launchPath === file.path)) return text().library.alreadyInLibrary;
      return extra.add(file);
    },
    [extra, items],
  );
  return {
    items,
    restorable,
    note: scanned.scanning
      ? scanned.note
      : libraryNote(scanned.items.length, items.length, extra.extras.hidden.length, scanned.note),
    scanning: scanned.scanning,
    rescan: () => {
      if (!inTauri()) return text().library.previewNoScan;
      scanned.rescan();
      return "";
    },
    addFromFile,
    setLaunchPath: extra.setLaunchPath,
    hide: extra.hide,
    restore: extra.restore,
  };
}
