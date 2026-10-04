import { invoke } from "@tauri-apps/api/core";
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
  /** 用户按了暂停（后端 `file_pause` 置上的）；任务中心据此把按钮翻成「继续」。 */
  paused: boolean;
  message: string;
  reason: string;
};

export type Job = TransferEvent & {
  at: number;
  /** 平滑过的速度（字节/秒）。取不到就是 0，界面就不显示速度那一行。 */
  rate: number;
  /** 按当前速度算的剩余秒数。0 = 算不出来（还没动 / 总量未知）。 */
  eta: number;
};

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

/**
 * 结束的任务的**记录**（任务中心用）。
 *
 * 为什么和上面那份分开：文件页底部那条进度只该显示「正在跑的」，8 秒后自动忘掉；
 * 而任务中心要能回答「刚才那趟搬完了没 / 跳过了几个」，所以留着记录，直到用户点
 * 「清空记录」。两份都放在模块级，理由和上面一样 —— 切页不丢。
 */
export type JobRecord = Job & { endedAt: number };
const HISTORY_MAX = 20;
let history: JobRecord[] = [];
let historySnapshot: JobRecord[] = [];

/** 结束的任务多留一会儿：文件页要拿它显示「已完成 / 已跳过几项」，然后自己忘掉。 */
const KEEP_DONE_MS = 8000;

function emit() {
  snapshot = [...jobs.values()].sort((a, b) => a.at - b.at);
  historySnapshot = [...history].sort((a, b) => b.endedAt - a.endedAt);
  listeners.forEach((listener) => listener());
}

function start() {
  if (started) return;
  started = true;
  void listen<TransferEvent>("files-transfer", (event) => {
    const payload = event.payload;
    if (!payload || !payload.id) return;
    const previous = jobs.get(payload.id);
    // 速度用相邻两次事件的差算，再跟上一值做个指数平滑：Rust 每 150ms 报一次，
    // 直接用瞬时值跳得厉害，读起来像坏了。
    let rate = previous?.rate ?? 0;
    if (previous && payload.bytes > previous.bytes) {
      const elapsed = (Date.now() - previous.at) / 1000;
      if (elapsed > 0) {
        const sample = (payload.bytes - previous.bytes) / elapsed;
        rate = rate > 0 ? rate * 0.6 + sample * 0.4 : sample;
      }
    }
    // 暂停中速度和剩余时间都没意义（等的那段时间全被算成「慢」），直接清零，
    // 界面就不会在暂停时还写着「剩余 30 秒」。
    if (payload.phase !== "run" || payload.paused) rate = 0;
    const remaining = payload.totalBytes - payload.bytes;
    const eta = rate > 0 && remaining > 0 ? remaining / rate : 0;
    const job: Job = { ...payload, at: Date.now(), rate, eta };
    jobs.set(payload.id, job);
    if (payload.phase !== "scan" && payload.phase !== "run") {
      const phase = payload.phase;
      history = [{ ...job, endedAt: Date.now() }, ...history.filter((row) => row.id !== payload.id)].slice(
        0,
        HISTORY_MAX,
      );
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

/**
 * 暂停 / 继续一个正在跑的活儿（后端 `file_pause`）。
 *
 * 界面**不猜**结果：后端在进出暂停时都会各报一次进度事件（`Runner::wait_if_paused`），
 * 按钮的文案跟着事件走 —— 命令回 false（活儿已经结束了）时什么都不用改，下一次事件
 * 自然会把它从「进行中」挪到「最近完成」。
 */
export function setJobPaused(id: string, paused: boolean): void {
  void invoke("file_pause", { id, paused }).catch(() => undefined);
}

/** 任务中心的「清空记录」：只清历史，正在跑的照旧。 */
export function clearJobHistory() {
  history = [];
  emit();
}

export function useFileJobs(): Job[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function useJobHistory(): JobRecord[] {
  return useSyncExternalStore(subscribe, () => historySnapshot);
}
