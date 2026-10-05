/*
 * 存储容量（画板 K5 首页底部那一格 + 侧栏左下那颗卡）。
 *
 * 为什么单独一个模块，而不是两处各自 invoke 一次：
 *   1. 这两处读的是**同一个**系统事实（一块盘的容量），各问一遍等于白问一遍；
 *   2. 更要紧的是**失败要能补读** —— 0.1.61 真机上侧栏那颗卡一直写「容量读取待接入」，
 *      因为它在启动那一瞬间问了一次，失败之后 `catch` 里把数组置空就再也没有第二次了：
 *      一次早到的失败，等于这张卡一直到关程序都是错的。
 *
 * 所以这里读不到（请求失败、或返回空 —— Windows 上系统盘不会凭空消失，空就是没读到）
 * 都按「这次没读到」处理，隔一会儿自己再问一次，最多补两回，之后认下来。
 * 拿不到就返回空数组，界面写「—」/「待接入」，绝不编数字。
 */
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export type DriveSpace = {
  mount: string;
  label: string;
  totalBytes: number;
  freeBytes: number;
  kind: string;
};

/** 补读的间隔（毫秒）。第一次失败最常见的原因是「问得太早」，所以第一次等得短一点。 */
const RETRY_DELAYS = [1200, 4000];

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let current: DriveSpace[] = [];
let loaded = false;
let inFlight: Promise<void> | null = null;
let retryTimer: number | null = null;
let retryAt = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function scheduleRetry() {
  if (retryTimer !== null || retryAt >= RETRY_DELAYS.length) return;
  const delay = RETRY_DELAYS[retryAt++];
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    startLoad();
  }, delay);
}

function startLoad() {
  // 已经有补读在排队就不必再起一次请求：那一次回来时照样会通知所有人。
  if (!inTauri() || loaded || inFlight || retryTimer !== null) return;
  inFlight = invoke<DriveSpace[]>("system_storage")
    .then((rows) => {
      current = Array.isArray(rows) ? rows : [];
    })
    .catch(() => {
      current = [];
    })
    .then(() => {
      inFlight = null;
      emit();
      if (current.length === 0 && retryAt < RETRY_DELAYS.length) {
        scheduleRetry();
      } else {
        loaded = true;
      }
    });
}

export function driveSpace(): DriveSpace[] {
  return current;
}

export function subscribeDriveSpace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 侧栏那颗卡与首页那一格共用这一个快照：谁先挂载谁去读，之后切页直接画上一次的结果，
 * 不再每次问一遍系统（跟工具箱页「快照 + 手动自检」一个路子）。
 */
export function useDriveSpace(): DriveSpace[] {
  const rows = useSyncExternalStore(subscribeDriveSpace, driveSpace);
  useEffect(() => {
    startLoad();
  }, []);
  return rows;
}
