import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

/** Rust 侧 `toolbox.rs::ModProgress` 的形状（事件名 `toolbox-mod-progress`）。 */
export type ModProgress = {
  phase: "download" | "extract" | "copy" | "done" | string;
  bytes: number;
  totalBytes: number;
};

/**
 * 进度放模块级，不放弹窗组件里。
 *
 * 为什么：OptiScaler 安装包 50 MB 上下，掌机网速下要下几十秒；用户这时候很可能把弹窗
 * 关掉、去别的页看一眼。状态放组件里那一关就没了，而 Rust 那边还在下 —— 放这里，
 * 回来时进度条还是接着的（和 `useFileJobs` 一个道理）。
 */
let progress: ModProgress | null = null;
const listeners = new Set<() => void>();
let started = false;

function emit() {
  listeners.forEach((listener) => listener());
}

function start() {
  if (started) return;
  started = true;
  void listen<ModProgress>("toolbox-mod-progress", (event) => {
    if (!event.payload) return;
    progress = event.payload;
    emit();
  }).catch(() => {
    /* 浏览器预览里没有事件，进度条就不出现 */
  });
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 开新一轮之前清掉上一轮：否则进度条会先显示上一次的 100%。 */
export function resetModProgress() {
  progress = null;
  emit();
}

export function useModProgress(): ModProgress | null {
  return useSyncExternalStore(subscribe, () => progress);
}
