/*
 * 最近启动记录（FUTURE.md 功能 14 第 10 条：K5 首页「继续游玩」的数据源）。
 *
 * 为什么要自己记：Windows 不告诉你「用户上次从这个前端启动了哪个游戏」—— Steam 有
 * localconfig、Epic 有 manifest，但「最近一次从这儿启动」只有**我们自己**知道。
 * 所以每次由启动器发起的启动都记一笔，只留最近 20 条（localStorage，切页不丢）。
 *
 * 为什么不做成 Rust 侧：这份记录只影响首页显示，后端一个字都不用知道；放前端还能
 * 同步更新（启动完立刻回首页就能看到它排第一）。
 */
import { useSyncExternalStore } from "react";

export type RecentLaunch = {
  id: string;
  name: string;
  /** 游戏还是软件 —— 首页的「继续游玩」只排游戏。 */
  kind: "game" | "app";
  /** 启动时刻（unix ms）。 */
  at: number;
  installPath?: string;
  launchPath?: string;
};

const KEY = "handheld-launcher.recent.v1";
const KEEP = 20;

let current: RecentLaunch[] = read();
const listeners = new Set<() => void>();

function read(): RecentLaunch[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentLaunch[];
    return Array.isArray(parsed) ? parsed.filter((row) => row && row.id && row.at) : [];
  } catch {
    return [];
  }
}

function write(next: RecentLaunch[]) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 存不下（隐私模式 / 配额满）：这一次仍然生效，只是下次启动回到空。
  }
  listeners.forEach((listener) => listener());
}

/**
 * 记一笔启动。同一个 id 再启动就把它挪到最前（不留两条），
 * 这样「继续游玩」永远是最近一次真的启动过的那个。
 */
export function recordLaunch(entry: Omit<RecentLaunch, "at">): void {
  const row: RecentLaunch = { ...entry, at: Date.now() };
  write([row, ...current.filter((item) => item.id !== row.id)].slice(0, KEEP));
}

export function recentLaunches(): RecentLaunch[] {
  return current;
}

export function subscribeRecent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRecentLaunches(): RecentLaunch[] {
  return useSyncExternalStore(subscribeRecent, recentLaunches);
}
