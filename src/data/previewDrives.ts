/*
 * 浏览器预览用的假盘表（只在没有 Tauri 后端时用）。
 *
 * 为什么需要：底部状态条那颗「存储空间」在真机上读的是 `system_storage`（Win32 直读），
 * 浏览器里读不到 —— 以前一律显示「容量读取待接入」，于是**「按盘符分别显示」这件事在预览里
 * 根本看不到、探针也断言不了**（探针跑的就是浏览器预览）。
 * 这和 `previewEmulators.ts` 是同一个路子：形状与后端**一字不差**（`DriveSpace`），
 * 数字是编的，但编得像真机（掌机常见：一块硬盘拆成 C: 系统盘 + D: 数据盘）。
 *
 * 真机上这份文件一点作用都没有（`inTauri()` 为真时走真实读数）。
 */
import type { DriveSpace } from "../system/drives";

const GB = 1024 ** 3;

/** C: 系统盘 + D: 数据盘（D 是启动器装模拟器 / 放 ROM 的那块）。 */
export const PREVIEW_DRIVES: DriveSpace[] = [
  {
    mount: "C:",
    label: "Windows",
    totalBytes: 476 * GB,
    freeBytes: 120 * GB,
    kind: "fixed",
  },
  {
    mount: "D:",
    label: "GameDrive",
    totalBytes: 954 * GB,
    freeBytes: 314 * GB,
    kind: "fixed",
  },
];
