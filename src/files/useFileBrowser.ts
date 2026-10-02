import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { playSfx } from "../audio/sfx";
import { currentLocale, text, useI18n } from "../i18n";

export type FileEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  bytes: number;
  editable: boolean;
};

type ClipItem = {
  path: string;
  name: string;
  kind: "dir" | "file";
};

type Clip = {
  items: ClipItem[];
  mode: "copy" | "move";
};

type PreviewNode = {
  name: string;
  kind: "dir" | "file";
  editable?: boolean;
  text?: string;
  children?: PreviewNode[];
};

const PREVIEW_ROOT = "preview:";

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

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return err.message;
  return text().files.actionFailed;
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

function toEntry(node: PreviewNode, path: string): FileEntry {
  return {
    name: node.name,
    path,
    kind: node.kind,
    bytes: node.kind === "file" ? new TextEncoder().encode(node.text ?? "").length : 0,
    editable: node.kind === "file" && node.editable !== false,
  };
}

function listPreview(root: PreviewNode, location: string | null): FileEntry[] {
  if (location == null) {
    return [toEntry(root, PREVIEW_ROOT)];
  }
  const node = findNode(root, location);
  if (!node || node.kind !== "dir") return [];
  return (node.children ?? [])
    .map((child) => toEntry(child, childPath(location, child.name)))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, currentLocale());
    });
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

/// The Files tab is unmounted on every tab switch (`key={tab}` in App.tsx), so
/// its folder and rows used to be thrown away: coming back re-asked for the
/// drive list and flashed "loading" again. Keep the last listing for this app
/// session so a remount paints immediately, then refresh in the background.
/// (Fresh answers skip the refresh entirely; the Rust side now does the walk
/// off the event loop, but repeating it for nothing is still wasted work.)
const LISTING_FRESH_MS = 3000;

type SessionListing = { location: string | null; rows: FileEntry[]; at: number };

let sessionListing: SessionListing | null = null;
const sessionFolders = new Map<string, SessionListing>();

function cachedRows(location: string | null): FileEntry[] {
  if (sessionListing !== null && sessionListing.location === location) return sessionListing.rows;
  if (location !== null) return sessionFolders.get(location)?.rows ?? [];
  return [];
}

function rememberRows(location: string | null, rows: FileEntry[]) {
  const entry: SessionListing = { location, rows, at: Date.now() };
  sessionListing = entry;
  if (location !== null) sessionFolders.set(location, entry);
}

function listingIsFresh(location: string | null): boolean {
  if (sessionListing === null || sessionListing.location !== location) return false;
  return Date.now() - sessionListing.at < LISTING_FRESH_MS;
}

export function useFileBrowser() {
  const { locale } = useI18n();
  const preview = !inTauri();
  const [location, setLocation] = useState<string | null>(() =>
    preview ? null : sessionListing?.location ?? null,
  );
  const [tree, setTree] = useState<PreviewNode>(() => previewTree());
  const [nativeEntries, setNativeEntries] = useState<FileEntry[]>(() =>
    preview ? [] : cachedRows(sessionListing?.location ?? null),
  );
  const [note, setNote] = useState("");
  const [clip, setClip] = useState<Clip | null>(null);
  const [pendingFocus, setPendingFocus] = useState("");

  useEffect(() => {
    if (preview) setTree(previewTree());
  }, [locale, preview]);

  const reloadNative = useCallback(async (path: string | null) => {
    try {
      const rows =
        path == null
          ? await invoke<FileEntry[]>("file_places")
          : await invoke<FileEntry[]>("file_list", { path });
      rememberRows(path, rows);
      setNativeEntries(rows);
    } catch (err) {
      setNativeEntries([]);
      const message = formatError(err);
      setNote((current) => current ? `${current}\n${message}` : message);
    }
  }, []);

  useEffect(() => {
    if (preview) return;
    if (listingIsFresh(location)) return;
    let cancel = false;
    void (async () => {
      try {
        const rows =
          location == null
            ? await invoke<FileEntry[]>("file_places")
            : await invoke<FileEntry[]>("file_list", { path: location });
        if (!cancel) {
          rememberRows(location, rows);
          setNativeEntries(rows);
        }
      } catch (err) {
        if (!cancel) {
          setNativeEntries([]);
          setNote(formatError(err));
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [location, preview]);

  const entries = preview ? listPreview(tree, location) : nativeEntries;

  const enter = useCallback((entry: FileEntry) => {
    if (entry.kind !== "dir") return;
    setLocation(entry.path);
    setNote("");
    setPendingFocus("");
  }, []);

  const up = useCallback(() => {
    if (location == null) return false;
    setLocation(parentPath(location));
    setNote("");
    setPendingFocus("");
    return true;
  }, [location]);

  const stage = useCallback((entries: FileEntry[], mode: Clip["mode"]) => {
    if (entries.length === 0) return;
    setClip({
      items: entries.map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind })),
      mode,
    });
    const t = text().files;
    const label =
      entries.length === 1
        ? t.quoted(entries[0].name)
        : currentLocale() === "zh"
          ? ` ${t.itemCount(entries.length)}`
          : t.itemCount(entries.length);
    setNote(mode === "copy" ? t.copiedClip(label) : t.moveClip(label));
  }, []);

  const paste = useCallback(async () => {
    if (!clip || clip.items.length === 0) return;
    if (location == null) {
      setNote(text().files.enterFolderFirst);
      return;
    }
    const countLabel = clip.items.length === 1 ? "" : text().files.itemCount(clip.items.length);
    if (preview) {
      let next = tree;
      let focus = clip.items[0].name;
      const done: string[] = [];
      for (const item of clip.items) {
        const applied = applyPreviewPaste(next, { ...item, mode: clip.mode }, location);
        if ("error" in applied) {
          setTree(next);
          if (clip.mode === "move") {
            setClip({ ...clip, items: clip.items.filter((entry) => !done.includes(entry.path)) });
          }
          setNote(done.length > 0 ? text().files.partial(done.length, applied.error) : applied.error);
          return;
        }
        next = applied.tree;
        focus = applied.focus;
        done.push(item.path);
      }
      setTree(next);
      if (clip.mode === "move") setClip(null);
      playSfx("paste");
      setNote(
        clip.items.length === 1
          ? clip.mode === "copy"
            ? text().files.pasted(focus)
            : text().files.moved(focus)
          : clip.mode === "copy"
            ? text().files.pastedMany(countLabel)
            : text().files.movedMany(countLabel),
      );
      setPendingFocus(focus);
      return;
    }
    const done: string[] = [];
    let failure = "";
    for (const item of clip.items) {
      try {
        await invoke(clip.mode === "copy" ? "file_copy" : "file_move", {
          from: item.path,
          destDir: location,
        });
        done.push(item.path);
      } catch (err) {
        failure = formatError(err);
        break;
      }
    }
    if (clip.mode === "move") {
      setClip(failure ? { ...clip, items: clip.items.filter((entry) => !done.includes(entry.path)) } : null);
    }
    setPendingFocus(clip.items.find((item) => done.includes(item.path))?.name ?? "");
    const t = text().files;
    if (done.length > 0 && !failure) playSfx("paste");
    setNote(
      failure
        ? done.length > 0
          ? t.partial(done.length, failure)
          : failure
        : clip.mode === "copy"
          ? clip.items.length === 1
            ? t.pasted(clip.items[0].name)
            : t.pastedMany(countLabel)
          : clip.items.length === 1
            ? t.moved(clip.items[0].name)
            : t.movedMany(countLabel),
    );
    await reloadNative(location);
  }, [clip, location, preview, reloadNative, tree]);

  const createDir = useCallback(
    async (name: string) => {
      const problem = checkFileName(name);
      if (problem) throw problem;
      if (location == null) throw text().files.enterFolderFirst;
      const trimmed = name.trim();
      if (preview) {
        const dest = findNode(tree, location);
        if (dest?.children?.some((child) => child.name === trimmed)) throw text().files.nameTaken;
        setTree((current) =>
          updateDir(current, location, (children) => [
            ...children,
            { name: trimmed, kind: "dir", children: [] },
          ]),
        );
        setPendingFocus(trimmed);
        setNote(text().files.folderCreated(trimmed));
        return;
      }
      await invoke("file_make_dir", { parent: location, name: trimmed });
      setPendingFocus(trimmed);
      setNote(text().files.folderCreated(trimmed));
      await reloadNative(location);
    },
    [location, preview, reloadNative, tree],
  );

  const createFile = useCallback(
    async (name: string) => {
      const problem = checkFileName(name);
      if (problem) throw problem;
      if (location == null) throw text().files.enterFolderFirst;
      const trimmed = name.trim();
      if (preview) {
        const dest = findNode(tree, location);
        if (dest?.children?.some((child) => child.name === trimmed)) throw text().files.nameTaken;
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
        if (!node || node.kind !== "file" || node.editable === false) throw text().files.notText;
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
        if (parent == null) throw text().files.cannotSave;
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
    async (entries: FileEntry[]) => {
      if (entries.length === 0) return;
      if (preview) {
        let next = tree;
        for (const entry of entries) {
          const parent = parentPath(entry.path);
          if (parent == null) {
            setNote(text().files.cannotDeleteHere);
            return;
          }
          next = updateDir(next, parent, (children) => children.filter((child) => child.name !== entry.name));
        }
        setTree(next);
        setNote(entries.length === 1 ? text().files.deletedOne(entries[0].name) : text().files.deletedMany(entries.length));
        return;
      }
      let done = 0;
      let failure = "";
      for (const entry of entries) {
        try {
          await invoke("file_delete", { path: entry.path });
          done += 1;
        } catch (err) {
          failure = formatError(err);
          break;
        }
      }
      const t = text().files;
      setNote(
        failure
          ? done > 0
            ? `${t.deletedMany(done)} ${failure}`
            : failure
          : entries.length === 1
            ? t.deletedOne(entries[0].name)
            : t.deletedMany(entries.length),
      );
      await reloadNative(location);
    },
    [location, preview, reloadNative, tree],
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

  return {
    preview,
    location,
    title: baseName(location),
    pathLabel: location ?? text().files.choosePlace,
    entries,
    note,
    clip,
    pendingFocus,
    clearPendingFocus: useCallback(() => setPendingFocus(""), []),
    enter,
    up,
    stageCopy: (entries: FileEntry[]) => stage(entries, "copy"),
    stageMove: (entries: FileEntry[]) => stage(entries, "move"),
    paste,
    createDir,
    createFile,
    readText,
    writeText,
    openExternal,
    remove,
    setNote,
  };
}
