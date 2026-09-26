import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PREVIEW_APPS, type AppEntry } from "../data/previewApps";
import { PREVIEW_GAMES, type GameEntry } from "../data/previewGames";
import { parentPath } from "../files/useFileBrowser";

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
};

type RawApp = {
  id: string;
  name: string;
  iconPath: string;
  installPath: string;
  launchPath: string;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let launching = false;

export async function launchLibraryItem(item: {
  id: string;
  name: string;
  launchPath?: string;
  installPath?: string;
  customPath?: boolean;
}): Promise<string> {
  if (!inTauri()) {
    return "浏览器预览不能启动。Windows 安装包里，在卡片上按 A 会打开程序。";
  }
  if (launching) return "正在启动…";
  launching = true;
  try {
    await invoke("launch_item", {
      id: item.customPath ? `file:${item.id}` : item.id,
      launchPath: item.launchPath ?? "",
      installPath: item.installPath ?? "",
    });
    return `已启动 ${item.name}`;
  } catch (err) {
    return `无法启动 ${item.name}：${formatError(err)}`;
  } finally {
    launching = false;
  }
}

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return err.message;
  return "扫描失败";
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
): { items: T[]; note: string } {
  const native = inTauri();
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!native) return;
    let cancel = false;
    invoke<TRaw[]>(command)
      .then((rows) => {
        if (cancel) return;
        const next = rows.map(map).sort((a, b) => a.name.localeCompare(b.name, "zh"));
        setItems(next);
        afterLoad?.(next, (updated) => {
          if (!cancel) setItems(updated);
        });
      })
      .catch((err: unknown) => {
        if (!cancel) setError(formatError(err));
      });
    return () => {
      cancel = true;
    };
  }, [afterLoad, command, map, native]);

  if (!native) return { items: preview, note: notes.preview };
  if (error) return { items: [], note: `扫描失败：${error}` };
  if (!items) return { items: [], note: notes.scanning };
  if (items.length === 0) return { items: [], note: notes.empty };
  return { items, note: notes.ready(items.length) };
}

function displayCover(row: RawGame): string {
  if (row.coverPath) return convertFileSrc(row.coverPath);
  return row.cover;
}

function mapGame(row: RawGame): GameEntry {
  return {
    id: row.id,
    name: row.name,
    cover: displayCover(row),
    installPath: row.installPath,
    launchPath: row.launchPath,
  };
}

function cacheMissingCovers(items: GameEntry[], update: (next: GameEntry[]) => void) {
  const pending = items.filter((game) => game.cover.startsWith("https://"));
  if (pending.length === 0) return;
  void invoke<Array<{ id: string; coverPath: string }>>("cache_covers", {
    covers: pending.map((game) => ({ id: game.id, url: game.cover })),
  })
    .then((saved) => {
      if (saved.length === 0) return;
      const paths = new Map(saved.map((item) => [item.id, item.coverPath]));
      update(
        items.map((game) => {
          const path = paths.get(game.id);
          return path ? { ...game, cover: convertFileSrc(path) } : game;
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

type Extras = {
  added: ExtraItem[];
  paths: Record<string, { launchPath: string; installPath: string }>;
};

function emptyExtras(): Extras {
  return { added: [], paths: {} };
}

function loadExtras(kind: "games" | "apps"): Extras {
  try {
    const raw = localStorage.getItem(`handheld-launcher.files.${kind}`);
    if (!raw) return emptyExtras();
    const parsed = JSON.parse(raw) as Partial<Extras>;
    return {
      added: Array.isArray(parsed.added) ? parsed.added : [],
      paths: parsed.paths && typeof parsed.paths === "object" ? parsed.paths : {},
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
      return `已添加「${name}」。按 A 会直接启动这个程序。`;
    },
    [kind],
  );

  const setLaunchPath = useCallback((id: string, file: PickedProgram) => {
    const launchPath = file.path;
    const installPath = parentPath(file.path) ?? "";
    const name = programName(file.name);
    setExtras((prev) => ({
      paths: { ...prev.paths, [id]: { launchPath, installPath } },
      added: prev.added.map((item) => (item.id === id ? { ...item, launchPath, installPath } : item)),
    }));
    return `已改为直接启动「${name}」。`;
  }, []);

  return { extras, add, setLaunchPath };
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

function libraryNote(scannedCount: number, shownCount: number, scannedNote: string) {
  if (scannedCount === 0 && shownCount > 0) return `没有新的扫描结果。手动添加的有 ${shownCount} 个。`;
  return scannedNote;
}

export function useLocalGames() {
  const scanned = useScanned("scan_games", PREVIEW_GAMES, {
    preview: "浏览器预览为示例封面。扫描本机游戏库需要 Windows 安装包。",
    scanning: "正在扫描本机 Steam / Epic 游戏…",
    empty: "没有扫到已安装的 Steam 或 Epic 游戏。",
    ready: (count) => `已扫描本机游戏 ${count} 个。封面会保存在本机，之后离线也能看。`,
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
    return [...base, ...added].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [extra.extras, scanned.items]);
  const addFromFile = useCallback(
    (file: PickedProgram) => {
      if (items.some((item) => item.launchPath === file.path)) return "这个程序已经在库里。";
      return extra.add(file);
    },
    [extra, items],
  );
  return {
    items,
    note: libraryNote(scanned.items.length, items.length, scanned.note),
    addFromFile,
    setLaunchPath: extra.setLaunchPath,
  };
}

export function useLocalApps() {
  const scanned = useScanned("scan_apps", PREVIEW_APPS, {
    preview: "浏览器预览为示例应用。扫描本机已安装软件需要 Windows 安装包。",
    scanning: "正在扫描本机已安装软件…",
    empty: "没有扫到可显示的已安装软件。",
    ready: (count) => `已扫描本机已安装软件 ${count} 个。`,
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
    return [...base, ...added].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [extra.extras, scanned.items]);
  const addFromFile = useCallback(
    (file: PickedProgram) => {
      if (items.some((item) => item.launchPath === file.path)) return "这个程序已经在库里。";
      return extra.add(file);
    },
    [extra, items],
  );
  return {
    items,
    note: libraryNote(scanned.items.length, items.length, scanned.note),
    addFromFile,
    setLaunchPath: extra.setLaunchPath,
  };
}
