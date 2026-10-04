/*
 * ⑧ 最近传输（改造包 §2.4）。
 *
 * 它不是一个「向导型」任务：点它就是跳到任务中心。所以 `jump` 一填，`TaskGrid` 就不会
 * 打开向导，而是让调用方切页 —— 本文件剩下的方法只是为了满足 `TaskDef` 的形状。
 */
import { text } from "../../i18n";
import type { TaskDef } from "./types";

export const recentJobs: TaskDef = {
  id: "recentJobs",
  accent: "accent-2",
  usesConflict: false,
  jump: "jobs",
  card: () => text().tasks.cards.recentJobs,

  unavailable() {
    return null;
  },

  async source() {
    return null;
  },

  async scan() {
    return { items: [], buckets: [] };
  },

  fields() {
    return [];
  },

  summary() {
    return { count: 0, totalBytes: 0, etaSec: 0, conflictPolicy: "skip" as const, notes: [] };
  },

  async run() {
    return { done: 0, skipped: 0, failed: 0, message: "" };
  },
};
