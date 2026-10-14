/*
 * 「现在库里有封面的游戏」的登记处 —— 屏保从这里取封面轮播。
 *
 * 为什么不直接在 App 里调 `useLocalGames()`（最直觉的写法）：那个 hook 一挂载就会
 * **触发全盘扫描**（`useScanned` 的规矩）。屏保是外壳上的东西，App 在启动那一刻就渲染它，
 * 于是变成「开机就扫一遍游戏库」，而用户可能开机只想进文件页 —— 白扫几十秒磁盘。
 *
 * 所以反过来：**谁在显示游戏库，谁就把封面登记进来**（`GamesPage` 挂一个 effect 上报）。
 * 屏保只读这一份快照，零成本、不触发任何 IO。副作用是「没进过游戏库就没有封面可放」，
 * 但那种情况下本来也没有封面 —— 屏保自己会因此不出现（见 App.tsx 的判据），
 * 而不是放一屏黑图。
 *
 * 为什么上报时要做深度比较再通知：`GamesPage` 的 `items` 每次渲染都是新数组，
 * 无脑 `emit` 会让订阅它的 App 每帧重渲染（屏保组件本身还要订阅它，直接就成了死循环）。
 */
import { useSyncExternalStore } from "react";

export type ScreensaverCover = {
  id: string;
  name: string;
  /** 本地缓存好的 `asset://` 封面。它同时是"离线兜底"，也是"没有别的图源"时的唯一选择。 */
  cover: string;
  /** 上面那张加载失败时的 HTTPS 兜底（和库里的卡片同一个规矩）。 */
  coverRemote?: string;
  /** Steam 数字 id。有它才有下面那些高清图源，手动添加的游戏没有。 */
  appId?: string;
};

let current: ScreensaverCover[] = [];
const listeners = new Set<() => void>();

/** 两张封面是不是同一张（含兜底地址）：判断「这份快照变没变」。 */
function sameCover(a: ScreensaverCover, b: ScreensaverCover): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.cover === b.cover &&
    a.coverRemote === b.coverRemote &&
    a.appId === b.appId
  );
}

/**
 * 屏保该按什么顺序试这张图 —— **从清楚到将就**。
 *
 * 为什么需要这个：屏保是**整屏一张图**，而库里缓存的封面是给卡片用的。
 * 实测（2026-10-14 用户反馈「为啥这么糊」时量的）：
 *
 * | 图源 | 实际分辨率 | 铺满 1920 的放大倍数 |
 * | --- | --- | --- |
 * | `library_600x900.jpg`（CDN 实际下发） | 300×450 | **6.5 倍** ← 库里缓存的常常是这一档 |
 * | `library_600x900_2x.jpg` | 600×900 | 3.2 倍 |
 * | `library_hero.jpg`（Steam 的宽幅资源） | **1920×620** | **1 倍** |
 *
 * 所以首选宽幅：它本来就是按宽屏构图的（**没有会被裁掉的字**），横向还 1:1 不用放大；
 * 竖版封面铺到 16:9 上既要放大六倍、又会被裁掉上下两头。
 *
 * 代价是屏保会**联网取图**（这些高清图不在本地缓存里）。换来的是"不糊"，值。
 * 取不到就一层层往下退，最后退到本地缓存那张 —— 断网时仍然有图，只是糊一点。
 */
export function screensaverCoverCandidates(item: ScreensaverCover): string[] {
  const out: string[] = [];
  if (item.appId && /^\d{1,10}$/.test(item.appId)) {
    // 宽幅：1920×620，整屏铺满几乎不用放大。
    out.push(`https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appId}/library_hero.jpg`);
    // 竖版 2x：600×900，宽幅没有这张时用它（仍然比 300 宽那档清楚一倍）。
    out.push(`https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appId}/library_600x900_2x.jpg`);
  }
  // 本地缓存（离线也有图）→ 它自己的线上兜底。
  if (item.cover) out.push(item.cover);
  if (item.coverRemote) out.push(item.coverRemote);
  return out;
}

/**
 * 登记当前的封面清单。传进来的顺序就是轮播顺序（`GamesPage` 已经按名称排好了）。
 *
 * 收进来的项里**只有带 `cover` 的**才会留下：手动添加的游戏没有封面，混进轮播就是一格空白。
 */
export function publishScreensaverCovers(items: ScreensaverCover[]): void {
  const next = items.filter((item) => item.id && item.cover);
  if (next.length === current.length && next.every((item, index) => sameCover(item, current[index]))) {
    return;
  }
  current = next;
  listeners.forEach((listener) => listener());
}

export function screensaverCovers(): ScreensaverCover[] {
  return current;
}

export function subscribeScreensaverCovers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useScreensaverCovers(): ScreensaverCover[] {
  return useSyncExternalStore(subscribeScreensaverCovers, screensaverCovers);
}
