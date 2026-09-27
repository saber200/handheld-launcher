import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PREVIEW_APPS, type AppEntry } from "../data/previewApps";
import { PREVIEW_GAMES, type GameEntry } from "../data/previewGames";
import { parentPath } from "../files/useFileBrowser";
import { currentLocale, text } from "../i18n";

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
  switchIfRunning?: boolean;
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
    if (outcome === "focused") return text().library.switched(item.name);
    if (outcome === "running") return text().library.alreadyRunning(item.name);
    return text().library.launched(item.name);
  } catch (err) {
    return text().library.launchFailed(item.name, formatError(err));
  } finally {
    launching = false;
  }
}

export function useRunningGameIds(items: GameEntry[]) {
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
    const tick = () => {
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
        .catch(() => {});
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

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return err.message;
  return text().library.failed;
}

function scanCacheKey(command: string) {
  return `handheld-launcher.scan.${command}`;
}

function readScanCache<TRaw>(command: string): TRaw[] | null {
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
  localStorage.setItem(scanCacheKey(command), JSON.stringify(rows));
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

  const finish = useCallback(
    (rows: TRaw[], cancel: { current: boolean }) => {
      writeScanCache(command, rows);
      const next = rows.map(map).sort((a, b) => a.name.localeCompare(b.name, currentLocale()));
      if (cancel.current) return;
      setItems(next);
      setError("");
      afterLoad?.(next, (updated) => {
        if (!cancel.current) setItems(updated);
      });
    },
    [afterLoad, command, map],
  );

  const run = useCallback(
    (cancel: { current: boolean }) => {
      setScanning(true);
      setError("");
      invoke<TRaw[]>(command)
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
    if (readScanCache<TRaw>(command)) return;
    const cancel = { current: false };
    run(cancel);
    return () => {
      cancel.current = true;
    };
  }, [command, native, run]);

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
      const cached = readScanCache<RawGame>("scan_games");
      if (cached) {
        writeScanCache(
          "scan_games",
          cached.map((row) => {
            const path = paths.get(row.id);
            return path ? { ...row, coverPath: path, cover: "" } : row;
          }),
        );
      }
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
      added: prev.added.filter((item) => item.id !== id),
      hidden: prev.hidden.includes(id) ? prev.hidden : [...prev.hidden, id],
    }));
    return text().library.hidden;
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

  return { extras, add, setLaunchPath, hide, setCover };
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
        const cover =
          saved.coverPath && inTauri()
            ? convertFileSrc(saved.coverPath)
            : saved.coverUrl || steamLibraryCover(saved.appId);
        return { ...item, cover };
      })
      .filter((item) => !extra.extras.hidden.includes(item.id))
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
  const addFromFile = useCallback(
    (file: PickedProgram) => {
      if (items.some((item) => item.launchPath === file.path)) return text().library.alreadyInLibrary;
      return extra.add(file);
    },
    [extra, items],
  );
  return {
    items,
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
  };
}
