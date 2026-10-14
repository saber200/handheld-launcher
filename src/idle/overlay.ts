/*
 * 屏保的开 / 关 / 正在关 —— 三个状态，和一个**给非 React 调用方**看的开关。
 *
 * 为什么要独立于 `idle/activity`：那一位只回答「多久没动手」，而屏保从「开始关」
 * 到「真的消失」还有一段 320ms 的淡出。这段时间里：
 *   · `idle` 已经是 false 了（用户确实动手了），
 *   · 但屏保还挂在屏幕上，
 *   · 于是**任何输入都必须继续被吞掉** —— 否则用户在淡出那 320ms 里按下的 A 会穿透到
 *     底下的游戏库，把游戏启动了。屏保是"看一眼封面"的功能，绝不能变成"手滑启动游戏"。
 *
 * 为什么不做成一个额外的布尔参数塞进 IdleTracker：那是两个正交的概念（时间 vs 界面），
 * 混在一起之后 `isIdle` 的语义就说不清了 —— 现在 `isIdle()` 的含义永远只有「超过一分钟
 * 没动手」，测起来也是干净的。
 *
 * 「能不能开」也在这里判（有没有封面、是不是正在搬文件）：那些条件的输入方在 App 里，
 * 但判据本身属于屏保，写在一处才不会出现"两个地方各判一半、合起来还是漏"。
 */
import { useEffect, useSyncExternalStore } from "react";
import { idle, idleSnapshot, subscribeIdle } from "./activity";
import { useFileJobs } from "../files/useFileJobs";

/** 淡出时长，要和 styles/screensaver.css 里 `.gs-root.leaving` 的动画对齐。 */
export const SCREENSAVER_FADE_MS = 320;

export type ScreensaverPhase = "hidden" | "open" | "closing";

export class ScreensaverOverlay {
  /** 屏保**看得见**（含淡出过程）。给 rAF 循环这种非 React 的地方读。 */
  private open = false;
  private closing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  /**
   * 「刚关掉、还没把按键状态重新对一遍」的标记。
   *
   * 屏保关掉的那一刻，用户手上通常还**按着**刚才唤醒用的那个键。如果不管它，
   * 等屏保卸载、那个键松开时，`useGamepadNav` 会把"一直按着"读成一次新按下，
   * 于是"按 A 关屏保"直接变成"启动游戏"。所以关掉之后先把按键状态重新采一遍，
   * 这个标记就是给 tick 看的信号，对完清掉。详见 hooks/useGamepadNav.ts 的 tick 开头。
   */
  private needsResync = false;

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  /** 现在该不该吞掉输入：看得见就算（淡出期间也算）。 */
  suppressInput(): boolean {
    return this.open;
  }

  /** 刚关掉、还没重新采样按键。tick 每帧问一次，采完调 `resynced()`。 */
  pendingResync(): boolean {
    return this.needsResync;
  }

  resynced(): void {
    this.needsResync = false;
  }

  /** 进屏保。重复调用无副作用。 */
  show(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.closing = false;
    if (this.open) return;
    this.open = true;
    this.emit();
  }

  /**
   * 开始关。
   *
   * `open` **立刻**置 false（输入从现在起不再被吞、rAF 立刻不再上报活动），
   * 但组件还要多活一会儿把淡出动画演完 —— `closing` 就是这段时间。
   */
  requestClose(immediate = false): void {
    if (!this.open && !this.closing) return;
    this.open = false;
    // 无论走不走淡出，唤醒那一下都按着键，都要重新采样一次。
    this.needsResync = true;
    if (immediate) {
      this.finish();
      return;
    }
    if (!this.closing) {
      this.closing = true;
      this.emit();
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.finish();
    }, SCREENSAVER_FADE_MS);
  }

  /** 窗口切走等场合：立刻收干净，不演淡出（反正用户看不见）。 */
  closeNow(): void {
    this.requestClose(true);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    // 注意这里必须**显式 return**：`useSyncExternalStore` 会把这个返回值当清理函数调用，
    // 返回 undefined 的话 React 会抛 "Cannot read properties of null (reading 'getSnapshot')"，
    // 而且是在渲染期抛、整个 App 一起白屏（本机实测过，见 FRONTEND.md）。
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * 快照用一个小整数编码两位状态：0 = 没有，1 = 看得见，2 = 正在淡出。
   *
   * `useSyncExternalStore` 的快照必须是**稳定值**（每次新建对象会被判定成"一直在变"，
   * React 会报 "getSnapshot should be cached" 并反复重渲染）。一个数字最省事。
   */
  snapshot = (): number => (this.open ? 1 : this.closing ? 2 : 0);

  private finish(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const changed = this.closing;
    this.closing = false;
    if (changed) this.emit();
  }
}

export const overlay = new ScreensaverOverlay();

/** 屏保现在画在屏幕上吗（含淡出中）。 */
export function screensaverShowing(): boolean {
  return overlay.snapshot() !== 0;
}

/** 输入该被吞掉吗 —— rAF 循环每帧问这个。 */
export function screensaverSuppressing(): boolean {
  return overlay.suppressInput();
}

export function requestScreensaverClose(): void {
  overlay.requestClose();
}

export function subscribeScreensaver(listener: () => void): () => void {
  return overlay.subscribe(listener);
}

export function screensaverSnapshot(): number {
  return overlay.snapshot();
}

function phaseOf(state: number): ScreensaverPhase {
  if (state === 2) return "closing";
  if (state === 1) return "open";
  return "hidden";
}

/** 订阅屏保该画成什么样。 */
export function useScreensaverPhase(): ScreensaverPhase {
  return phaseOf(useSyncExternalStore(subscribeScreensaver, screensaverSnapshot));
}

/**
 * 「能不能进屏保」的判据。
 *
 * `hasCovers` 由调用方从登记处（`library/shelf`）取，因为"有没有封面"是库的事。
 *
 * 正在搬文件 / 装东西时**不进**：`useFileJobs` 里 `scan` 和 `run` 是"还在跑"的两个相位，
 * 其余（done / cancelled / error）是终态。用户在盯着进度条的时候弹一屏封面，
 * 是把这个功能变成打扰。
 *
 * ⚠️ **这里必须是 hook，而且必须在调用方无条件调用。** 曾经写成
 * `hasCovers && useFileJobs().some(...)` 的普通函数：`hasCovers` 一开始是 false，
 * `&&` 就短路了，于是第一轮渲染少调一个 hook —— React 直接抛
 * "change in the order of Hooks"，整个 App 白屏（本机实测，`?screensaver=1` 那次）。
 * hook 不能藏在 `&&` / `||` / 三元后面，这条没有例外。
 */
export function useScreensaverAllowed(allowed = true): boolean {
  const busy = useFileJobs().some((job) => job.phase === "scan" || job.phase === "run");
  return allowed && !busy;
}

/**
 * 把「空闲」和「能不能开」两头对上：该开就开，不该开就收，并回报现在该画什么。
 *
 * 为什么要有这个 effect 而不是单纯靠 `idle` 渲染：进屏保是**有条件的**
 * （得先有封面、且没在搬文件）。条件不满足时 `idle` 仍然是 true，
 * 组件什么都不画；等条件满足（比如扫描回来了）这一轮 effect 会重新跑，屏保才真的出现 ——
 * 这就是"没封面时不进屏保，有封面了再进"的实现。
 *
 * `force` 是浏览器预览里的调试入口（`?screensaver=1`）：真机上验证一次要坐着等一分钟，
 * 调样式的时候完全没法用。它**只跳过「空闲」这一条**，「有没有封面 / 在不在搬文件」
 * 照旧判 —— 调试入口不该能造出一个正式流程里不存在的状态。
 */
export function useScreensaverOverlay(
  allowed: boolean,
  force = false,
  idleOverrideMs = 0,
): ScreensaverPhase {
  // 本地这个名字不能叫 `idle` —— 会和上面 import 进来的那个单例（调试用）撞名。
  const isIdle = useSyncExternalStore(subscribeIdle, idleSnapshot);
  const state = useSyncExternalStore(subscribeScreensaver, screensaverSnapshot);
  const showing = state !== 0;
  const want = force || isIdle;

  // 调试用的阈值覆盖（浏览器预览的 `?idle=5`）：只在传了正数时生效。
  useEffect(() => {
    if (idleOverrideMs > 0) idle.setTimeoutMs(idleOverrideMs);
  }, [idleOverrideMs]);

  useEffect(() => {
    if (want && allowed) {
      overlay.show();
      return;
    }
    // 收屏保只在它真开着的时候做，别每帧空调。
    if (showing) {
      if (!want) overlay.requestClose();
      else if (!allowed) overlay.closeNow();
    }
  }, [want, allowed, showing]);

  return phaseOf(state);
}
