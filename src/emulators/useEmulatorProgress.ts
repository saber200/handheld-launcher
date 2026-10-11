/*
 * 模拟器页的进度（Rust 侧 `emulator.rs` 的 `EMU_EVENT` 事件）。
 *
 * 为什么放模块级、不放页面组件里：一次安装要下 30–200 MB，掌机网速下是几分钟的事，
 * 用户这时候很可能切到别的页看一眼再回来 —— 状态放组件里，`<div key={tab}>` 一切走就没了，
 * 而 Rust 那边还在下。跟 `useModProgress`（装 OptiScaler）一个道理。
 *
 * 和那个文件的区别只有一处：这里多了 `phase`，因为一次安装有四个阶段
 * （查版本 → 下载 → 解压 → 搬运），进度条上要写清楚现在在干嘛 ——
 * 「解压 RetroArch」那一步能静静地跑十几秒，什么都不说的话看着就像卡死了。
 */
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

/** Rust 侧 `EmulatorProgress` 的形状。 */
export type EmulatorPhase = "resolve" | "download" | "extract" | "copy" | "done";

export type EmulatorProgress = {
  phase: EmulatorPhase | string;
  bytes: number;
  totalBytes: number;
};

type State = {
  /** 正在装哪一个（空 = 没有在装）。 */
  id: string;
  progress: EmulatorProgress | null;
};

let state: State = { id: "", progress: null };
const listeners = new Set<() => void>();
let started = false;

function emit() {
  listeners.forEach((listener) => listener());
}

function start() {
  if (started) return;
  started = true;
  void listen<EmulatorProgress>("emulator-install-progress", (event) => {
    if (!event.payload) return;
    state = { ...state, progress: event.payload };
    emit();
  }).catch(() => {
    /* 浏览器预览里没有事件源，进度条就不出现 */
  });
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 开新一轮之前调用：不清的话进度条会先显示上一次的 100%。 */
export function beginEmulatorInstall(id: string) {
  state = { id, progress: null };
  emit();
}

export function endEmulatorInstall() {
  state = { id: "", progress: null };
  emit();
}

export function useEmulatorProgress(): State {
  return useSyncExternalStore(subscribe, () => state);
}
