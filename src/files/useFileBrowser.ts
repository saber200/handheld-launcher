import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

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

const INITIAL_PREVIEW: PreviewNode = {
  name: "本机预览",
  kind: "dir",
  children: [
    {
      name: "文档",
      kind: "dir",
      children: [
        {
          name: "笔记.txt",
          kind: "file",
          editable: true,
          text: "这是预览笔记。\n改完后把焦点移到保存，按 A。",
        },
      ],
    },
    {
      name: "说明.txt",
      kind: "file",
      editable: true,
      text: "浏览器里的文件不会写到磁盘。",
    },
    { name: "封面.png", kind: "file", editable: false },
  ],
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return err.message;
  return "操作失败";
}

export function checkFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "请输入名称";
  if (trimmed === "." || trimmed === ".." || trimmed.length > 120) return "这个名称不能用";
  if (/[\\/:*?"<>|]/.test(trimmed) || [...trimmed].some((c) => c.charCodeAt(0) < 32)) {
    return "名称里不能有 \\ / : * ? \" < > |";
  }
  const stem = (trimmed.split(".")[0] ?? trimmed).toUpperCase();
  if (["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "LPT1", "LPT2"].includes(stem)) {
    return "这个名称不能用";
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
  if (path == null) return "盘符";
  if (path === PREVIEW_ROOT) return "本机预览";
  if (path === "/") return "根目录";
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
      return a.name.localeCompare(b.name, "zh");
    });
}

function uniqueName(siblings: PreviewNode[], name: string): string {
  if (!siblings.some((child) => child.name === name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 100; n += 1) {
    const candidate = ext
      ? `${stem} 副本${n === 1 ? "" : ` ${n}`}${ext}`
      : `${stem} 副本${n === 1 ? "" : ` ${n}`}`;
    if (!siblings.some((child) => child.name === candidate)) return candidate;
  }
  return `${name}.copy`;
}

function applyPreviewPaste(
  tree: PreviewNode,
  clip: ClipItem & { mode: Clip["mode"] },
  location: string,
): { tree: PreviewNode; focus: string; message: string } | { error: string } {
  const source = findNode(tree, clip.path);
  if (!source) return { error: "找不到要粘贴的项目。" };
  const parent = parentPath(clip.path);
  if (clip.mode === "move" && parent === location) return { error: "已经在这个文件夹里。" };
  if (clip.kind === "dir" && (location === clip.path || location.startsWith(`${clip.path}/`))) {
    return { error: "不能粘贴到它自己里面。" };
  }
  const dest = findNode(tree, location);
  if (!dest || dest.kind !== "dir") return { error: "只能粘贴到文件夹里。" };
  const siblings = dest.children ?? [];
  if (clip.mode === "move" && siblings.some((child) => child.name === source.name)) {
    return { error: "目标里已经有同名项目。" };
  }
  const focus = clip.mode === "copy" ? uniqueName(siblings, source.name) : source.name;
  let next = updateDir(tree, location, (children) => [...children, { ...cloneNode(source), name: focus }]);
  if (clip.mode === "move" && parent) {
    next = updateDir(next, parent, (children) => children.filter((child) => child.name !== source.name));
  }
  return {
    tree: next,
    focus,
    message: clip.mode === "copy" ? `已粘贴「${focus}」。` : `已移动「${focus}」。`,
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

export function useFileBrowser() {
  const preview = !inTauri();
  const [location, setLocation] = useState<string | null>(null);
  const [tree, setTree] = useState<PreviewNode>(INITIAL_PREVIEW);
  const [nativeEntries, setNativeEntries] = useState<FileEntry[]>([]);
  const [note, setNote] = useState("");
  const [clip, setClip] = useState<Clip | null>(null);
  const [pendingFocus, setPendingFocus] = useState("");

  const reloadNative = useCallback(async (path: string | null) => {
    try {
      const rows =
        path == null
          ? await invoke<FileEntry[]>("file_places")
          : await invoke<FileEntry[]>("file_list", { path });
      setNativeEntries(rows);
      setNote("");
    } catch (err) {
      setNativeEntries([]);
      setNote(formatError(err));
    }
  }, []);

  useEffect(() => {
    if (preview) return;
    let cancel = false;
    void (async () => {
      try {
        const rows =
          location == null
            ? await invoke<FileEntry[]>("file_places")
            : await invoke<FileEntry[]>("file_list", { path: location });
        if (!cancel) {
          setNativeEntries(rows);
          setNote("");
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
    setPendingFocus("");
  }, []);

  const up = useCallback(() => {
    if (location == null) return false;
    setLocation(parentPath(location));
    setPendingFocus("");
    return true;
  }, [location]);

  const stage = useCallback((entries: FileEntry[], mode: Clip["mode"]) => {
    if (entries.length === 0) return;
    setClip({
      items: entries.map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind })),
      mode,
    });
    const label = entries.length === 1 ? `「${entries[0].name}」` : `${entries.length} 项`;
    const gap = entries.length === 1 ? "" : " ";
    setNote(
      mode === "copy"
        ? `已复制${gap}${label}。打开目标文件夹后按粘贴。`
        : `已准备移动${gap}${label}。打开目标文件夹后按粘贴。`,
    );
  }, []);

  const paste = useCallback(async () => {
    if (!clip || clip.items.length === 0) return;
    if (location == null) {
      setNote("先进入一个文件夹，再粘贴。");
      return;
    }
    const countLabel = clip.items.length === 1 ? "" : `${clip.items.length} 项`;
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
          setNote(done.length > 0 ? `已处理 ${done.length} 项。${applied.error}` : applied.error);
          return;
        }
        next = applied.tree;
        focus = applied.focus;
        done.push(item.path);
      }
      setTree(next);
      if (clip.mode === "move") setClip(null);
      setNote(
        clip.items.length === 1
          ? clip.mode === "copy"
            ? `已粘贴「${focus}」。`
            : `已移动「${focus}」。`
          : clip.mode === "copy"
            ? `已粘贴 ${countLabel}。`
            : `已移动 ${countLabel}。`,
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
    setNote(
      failure
        ? done.length > 0
          ? `已处理 ${done.length} 项。${failure}`
          : failure
        : clip.mode === "copy"
          ? clip.items.length === 1
            ? `已粘贴「${clip.items[0].name}」。`
            : `已粘贴 ${countLabel}。`
          : clip.items.length === 1
            ? `已移动「${clip.items[0].name}」。`
            : `已移动 ${countLabel}。`,
    );
    await reloadNative(location);
  }, [clip, location, preview, reloadNative, tree]);

  const createDir = useCallback(
    async (name: string) => {
      const problem = checkFileName(name);
      if (problem) throw problem;
      if (location == null) throw "先进入一个文件夹。";
      const trimmed = name.trim();
      if (preview) {
        const dest = findNode(tree, location);
        if (dest?.children?.some((child) => child.name === trimmed)) throw "已经有同名项目";
        setTree((current) =>
          updateDir(current, location, (children) => [
            ...children,
            { name: trimmed, kind: "dir", children: [] },
          ]),
        );
        setPendingFocus(trimmed);
        setNote(`已新建文件夹「${trimmed}」。`);
        return;
      }
      await invoke("file_make_dir", { parent: location, name: trimmed });
      setPendingFocus(trimmed);
      setNote(`已新建文件夹「${trimmed}」。`);
      await reloadNative(location);
    },
    [location, preview, reloadNative, tree],
  );

  const createFile = useCallback(
    async (name: string) => {
      const problem = checkFileName(name);
      if (problem) throw problem;
      if (location == null) throw "先进入一个文件夹。";
      const trimmed = name.trim();
      if (preview) {
        const dest = findNode(tree, location);
        if (dest?.children?.some((child) => child.name === trimmed)) throw "已经有同名项目";
        setTree((current) =>
          updateDir(current, location, (children) => [
            ...children,
            { name: trimmed, kind: "file", editable: true, text: "" },
          ]),
        );
        setPendingFocus(trimmed);
        setNote(`已新建「${trimmed}」。`);
        return childPath(location, trimmed);
      }
      await invoke("file_make_file", { parent: location, name: trimmed });
      setPendingFocus(trimmed);
      setNote(`已新建「${trimmed}」。`);
      await reloadNative(location);
      return childPath(location, trimmed);
    },
    [location, preview, reloadNative, tree],
  );

  const readText = useCallback(
    async (entry: FileEntry) => {
      if (preview) {
        const node = findNode(tree, entry.path);
        if (!node || node.kind !== "file" || node.editable === false) throw "这个文件不是文本";
        return node.text ?? "";
      }
      return invoke<string>("file_read_text", { path: entry.path });
    },
    [preview, tree],
  );

  const writeText = useCallback(
    async (path: string, text: string) => {
      if (preview) {
        const parent = parentPath(path);
        const name = baseName(path);
        if (parent == null) throw "无法保存";
        setTree((current) =>
          updateDir(current, parent, (children) =>
            children.map((child) => (child.name === name ? { ...child, text } : child)),
          ),
        );
        setNote(`已保存「${name}」。`);
        return;
      }
      await invoke("file_write_text", { path, text });
      setNote(`已保存「${baseName(path)}」。`);
    },
    [preview],
  );

  const openExternal = useCallback(
    async (entry: FileEntry) => {
      if (preview) {
        setNote("浏览器预览不能调用系统打开。文本文件请用编辑。");
        return;
      }
      await invoke("file_open", { path: entry.path });
      setNote(`已打开「${entry.name}」。`);
    },
    [preview],
  );

  return {
    preview,
    location,
    title: baseName(location),
    pathLabel: location ?? "选择盘符或用户文件夹",
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
    setNote,
  };
}
