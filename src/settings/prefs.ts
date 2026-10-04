/*
 * 纯前端的界面偏好（FUTURE.md 功能 14 第 5 条）：界面缩放 + 手柄死区。
 *
 * 为什么放 localStorage 而不是 settings.json：两者都只影响**这台机器上的这块屏**，
 * 后端一个字都不用知道（TDP 那种要写 MSR 的才必须走后端）。文件页的布局、双栏开关
 * 也是这么存的，这里跟着同一个路子走，不新开一条「设置通道」。
 *
 * 为什么做成带订阅的模块级状态：改死区要**当场生效**（用户推摇杆试一下就知道手感），
 * 而 `useGamepadNav` 是在 App 里跑的另一个闭包，拿不到设置抽屉的 state。
 */
import { useSyncExternalStore } from "react";

export type Prefs = {
  /** 界面缩放系数：在「按屏幕自动算」的基础上再乘一个数。 */
  scale: number;
  /** 摇杆死区（0..1）：超过它才算「推了方向」。越小越灵敏。 */
  deadzone: number;
};

/** 缩放的三档。0.9 是「字太大 / 想一屏看更多」，1.1 是「离得远、要更大」。 */
export const SCALE_CHOICES = [0.9, 1, 1.1] as const;
/** 死区的四档。0.25 灵敏（老化摇杆会飘）、0.55 迟钝但绝不误触。 */
export const DEADZONE_CHOICES = [0.25, 0.35, 0.45, 0.55] as const;

/** 默认值必须和 0.1.60 的行为一致：缩放 1、死区 0.45（`useGamepadNav` 里原来那个常数）。 */
const DEFAULTS: Prefs = { scale: 1, deadzone: 0.45 };

const KEY = "handheld-launcher.prefs.v1";

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      // 只接受三档里的值：手改过 localStorage 的数值会让整页排版崩掉，
      // 这种输入不值得信任。
      scale: SCALE_CHOICES.includes(parsed.scale as (typeof SCALE_CHOICES)[number])
        ? (parsed.scale as number)
        : DEFAULTS.scale,
      deadzone: DEADZONE_CHOICES.includes(parsed.deadzone as (typeof DEADZONE_CHOICES)[number])
        ? (parsed.deadzone as number)
        : DEFAULTS.deadzone,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = read();
const listeners = new Set<() => void>();

export function prefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs>): Prefs {
  const next: Prefs = {
    scale: patch.scale != null ? clamp(patch.scale, 0.5, 2) : current.scale,
    deadzone: patch.deadzone != null ? clamp(patch.deadzone, 0.05, 0.9) : current.deadzone,
  };
  if (next.scale === current.scale && next.deadzone === current.deadzone) return current;
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 存不下（隐私模式 / 配额满）：这一次仍然生效，只是下次启动回到默认。
  }
  listeners.forEach((listener) => listener());
  return current;
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, prefs);
}
