/*
 * 图片缩略图：`file_thumb` 的前端缓存层。
 *
 * 为什么要缓存（而不是每次渲染都问一次）：焦点每上下动一格，文件行与预览面板都会重新
 * 渲染一次；Rust 侧虽然也有缓存，但每次过桥都是一次 IPC 往返 + 一个 base64 字符串。
 * 这里存的是最终能直接塞进 `<img src>` 的 data URL。
 *
 * 失败也缓存（同一个值 `THUMB_FAILED`）：坏图、超大图、系统目录 —— 这些每次都会失败，
 * 不记住的话焦点每回到那一行就再问一遍，白白卡一下。
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/** 列表缩略图的目标边长（画板 F2：32×32 的块，2 倍图够清晰）。 */
export const THUMB_LIST = 96;
/** 预览面板的目标边长（画板 F2：424 宽的 16:9 区域）。 */
export const THUMB_PREVIEW = 480;

const FAILED = "\u0000failed";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function keyOf(path: string, maxEdge: number): string {
  return `${path}|${maxEdge}`;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function load(path: string, maxEdge: number): Promise<string> {
  if (!inTauri()) return FAILED;
  try {
    const base64 = await invoke<string>("file_thumb", { path, maxEdge });
    return `data:image/png;base64,${base64}`;
  } catch {
    return FAILED;
  }
}

function request(path: string, maxEdge: number): Promise<string> {
  const key = keyOf(path, maxEdge);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(key);
  if (running) return running;
  const task = load(path, maxEdge).then((value) => {
    cache.set(key, value);
    inflight.delete(key);
    return value;
  });
  inflight.set(key, task);
  return task;
}

export type ThumbState = {
  /** 能直接给 `<img src>` 的 data URL；还没好 / 失败时是 null。 */
  src: string | null;
  /** 失败（大图、坏图、系统目录、浏览器预览）。界面据此显示占位图标。 */
  failed: boolean;
  /** 还在做。界面据此显示占位骨架。 */
  loading: boolean;
};

/**
 * 取一张缩略图。`path` 为空（没选中任何东西）时什么都不做。
 *
 * 只对图片调用：非图片会被 Rust 侧直接拒绝，白白多一次 IPC。
 */
export function useThumb(path: string | null, maxEdge: number): ThumbState {
  const [state, setState] = useState<ThumbState>(() => {
    if (!path) return { src: null, failed: false, loading: false };
    const cached = cache.get(keyOf(path, maxEdge));
    if (cached === FAILED) return { src: null, failed: true, loading: false };
    if (cached) return { src: cached, failed: false, loading: false };
    return { src: null, failed: false, loading: true };
  });

  useEffect(() => {
    if (!path) {
      setState({ src: null, failed: false, loading: false });
      return;
    }
    const cached = cache.get(keyOf(path, maxEdge));
    if (cached === FAILED) {
      setState({ src: null, failed: true, loading: false });
      return;
    }
    if (cached) {
      setState({ src: cached, failed: false, loading: false });
      return;
    }
    let alive = true;
    setState({ src: null, failed: false, loading: true });
    void request(path, maxEdge).then((value) => {
      if (!alive) return;
      setState(
        value === FAILED
          ? { src: null, failed: true, loading: false }
          : { src: value, failed: false, loading: false },
      );
    });
    return () => {
      alive = false;
    };
  }, [path, maxEdge]);

  return state;
}

/** 图片类扩展名：只有这些才值得去要缩略图。 */
export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|webp|bmp|gif|ico)$/i.test(name);
}
