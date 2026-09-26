import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { PREVIEW_APPS, type AppEntry } from "../data/previewApps";
import { PREVIEW_GAMES, type GameEntry } from "../data/previewGames";

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
  installPath: string;
  launchPath: string;
};

type RawApp = {
  id: string;
  name: string;
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
}): Promise<string> {
  if (!inTauri()) {
    return "浏览器预览不能启动。Windows 安装包里，在卡片上按 A 会打开程序。";
  }
  if (launching) return "正在启动…";
  launching = true;
  try {
    await invoke("launch_item", {
      id: item.id,
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
      })
      .catch((err: unknown) => {
        if (!cancel) setError(formatError(err));
      });
    return () => {
      cancel = true;
    };
  }, [command, map, native]);

  if (!native) return { items: preview, note: notes.preview };
  if (error) return { items: [], note: `扫描失败：${error}` };
  if (!items) return { items: [], note: notes.scanning };
  if (items.length === 0) return { items: [], note: notes.empty };
  return { items, note: notes.ready(items.length) };
}

function mapGame(row: RawGame): GameEntry {
  return {
    id: row.id,
    name: row.name,
    cover: row.cover,
    installPath: row.installPath,
    launchPath: row.launchPath,
  };
}

function mapApp(row: RawApp): AppEntry {
  const text = row.name.trim();
  const first = Array.from(text)[0] ?? "?";
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return {
    id: row.id,
    name: row.name,
    mark: first.toUpperCase(),
    color: APP_COLORS[hash % APP_COLORS.length],
    installPath: row.installPath,
    launchPath: row.launchPath,
  };
}

export function useLocalGames() {
  return useScanned("scan_games", PREVIEW_GAMES, {
    preview: "浏览器预览为示例封面。扫描本机游戏库需要 Windows 安装包。",
    scanning: "正在扫描本机 Steam / Epic 游戏…",
    empty: "没有扫到已安装的 Steam 或 Epic 游戏。",
    ready: (count) => `已扫描本机游戏 ${count} 个。封面来自 Steam，需要能访问网络。`,
  }, mapGame);
}

export function useLocalApps() {
  return useScanned("scan_apps", PREVIEW_APPS, {
    preview: "浏览器预览为示例应用。扫描本机已安装软件需要 Windows 安装包。",
    scanning: "正在扫描本机已安装软件…",
    empty: "没有扫到可显示的已安装软件。",
    ready: (count) => `已扫描本机已安装软件 ${count} 个。`,
  }, mapApp);
}
