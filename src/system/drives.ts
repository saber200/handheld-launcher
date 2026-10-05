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
 *
 * 界面要的「容量」不是某一块盘的，而是 `driveTotal()` 算出来的**所有内置盘之和** ——
 * 常用机型往往是一块硬盘拆成 C: + D: 两个分区，只画 C: 那个数比机器真实存储小一大截。
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

/** `driveTotal()` 的结果：几块内置盘加在一起的总量与用量。 */
export type DriveTotal = {
  /** 参与相加的盘符，保持后端给的顺序（内置盘在前），如 `["C:", "D:"]`。 */
  mounts: string[];
  /** 只有一块盘参与时的卷标；多块盘时为空串（一块盘的卷标代表不了合计）。 */
  label: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
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

/**
 * 把「所有内置盘」加成一个总量（侧栏那颗卡与首页那一格都读它）。
 *
 * 为什么不是取第一块盘（`drives.find(kind === "fixed")`）：掌机上常见的是**一块硬盘拆成
 * C: + D: 几个分区**，只画 C: 的话那个数字比机器真实的存储小一大截 —— 用户 2026-10-05
 * 反馈的就是这个（「不应该只有 C 盘的，而是所有盘符的总合」）。总量 = 各分区容量相加，
 * 用量 = 各分区已用相加：一块盘拆成几个分区，不影响这个数。
 *
 * **只加 `kind === "fixed"`（内置盘）**：U 盘 / SD 卡插上拔下不该让这颗卡的数字自己跳。
 * 但**一块内置盘都没认出来时退回把所有盘相加** —— 宁可把移动盘也算进去，也不要让这张卡
 * 空着（跟本文件上面那条「空 = 没读到」一个道理）。
 *
 * 一盘都没读到（`[]`）返回 null，界面写「—」/「待接入」，绝不编数字。
 */
export function driveTotal(rows: DriveSpace[]): DriveTotal | null {
  if (rows.length === 0) return null;
  const fixed = rows.filter((row) => row.kind === "fixed");
  const counted = fixed.length > 0 ? fixed : rows;
  let totalBytes = 0;
  let freeBytes = 0;
  for (const row of counted) {
    totalBytes += row.totalBytes;
    freeBytes += row.freeBytes;
  }
  return {
    mounts: counted.map((row) => row.mount),
    label: counted.length === 1 ? counted[0].label : "",
    totalBytes,
    freeBytes,
    // 分区之间可能互相挂载导致 free > total 这类怪读数，用量兜一下底、不写负数。
    usedBytes: Math.max(0, totalBytes - freeBytes),
  };
}
