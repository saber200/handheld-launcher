/*
 * 任务表。
 *
 * 顺序即界面顺序（改造包 §2.1）：最常用的放最前 —— 掌机上打开文件页的动机里，
 * 「把 ROM 装进模拟器」远多于「我要整理文件夹」。
 *
 * 加第 9 个任务 = 加一个文件 + 在这里加一行 + 在两个语言包里加三段文案，向导一行都不用改。
 */
import { backupSaves } from "./backupSaves";
import { cleanup } from "./cleanup";
import { exportShots } from "./exportShots";
import { importRom } from "./importRom";
import { installMod } from "./installMod";
import { recentJobs } from "./recentJobs";
import { restoreSaves } from "./restoreSaves";
import type { TaskDef, TaskId } from "./types";
import { usb } from "./usb";

export const TASKS: TaskDef[] = [
  importRom,
  installMod,
  backupSaves,
  restoreSaves,
  exportShots,
  cleanup,
  usb,
  recentJobs,
];

export function taskById(id: TaskId): TaskDef | undefined {
  return TASKS.find((task) => task.id === id);
}

export type { TaskDef, TaskId } from "./types";
export { taskCtx, externalDrives, formatBytes, formatEta, joinPath, nameOf, parentOf } from "./env";
