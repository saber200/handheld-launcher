import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

export type JobPhase = "scan" | "run" | "done" | "cancelled" | "error";

/** Rust 侧 `files.rs::TransferProgress` 的形状（事件名 `files-transfer`）。 */
export type TransferEvent = {
  id: string;
  phase: JobPhase;
  name: string;
  itemIndex: number;
  itemTotal: number;
  itemsDone: number;
  skipped: number;
  bytes: number;
  totalBytes: number;
  message: string;
  reason: string;
};

export type Job = TransferEvent & { at: number };

/**
 * 任务状态放在模块级，不放组件里。
 *
 * 为什么：复制一个 20 GB 的游戏要几分钟，用户中途按 LB 去游戏库看一眼是正常的；文件页
 * 一切标签就会被卸载（App.tsx 的 `key={tab}`），状态放组件里那一趟回来进度就没了 ——
 * 而后端的线程还在老老实实拷。放这里，事件一直在收，回来时进度条还是接着的。
 */
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
let snapshot: Job[] = [];
let started = false;

/** 结束的任务多留一会儿：页面要拿它显示「已完成 / 已跳过几项」，然后自己忘掉。 */
const KEEP_DONE_MS = 8000;

function emit() {
  snapshot = [...jobs.values()].sort((a, b) => a.at - b.at);
  listeners.forEach((listener) => listener());
}

function start() {
  if (started) return;
  started = true;
  void listen<TransferEvent>("files-transfer", (event) => {
    const payload = event.payload;
    if (!payload || !payload.id) return;
    jobs.set(payload.id, { ...payload, at: Date.now() });
    if (payload.phase !== "scan" && payload.phase !== "run") {
      const phase = payload.phase;
      window.setTimeout(() => {
        // 只有还是同一个收尾状态才清：中间又跑了新的一轮就别动。
        if (jobs.get(payload.id)?.phase === phase) forgetJob(payload.id);
      }, KEEP_DONE_MS);
    }
    emit();
  }).catch(() => {
    /* 浏览器预览里没有事件，任务面板就不出现 */
  });
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function forgetJob(id: string) {
  if (jobs.delete(id)) emit();
}

export function useFileJobs(): Job[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}
