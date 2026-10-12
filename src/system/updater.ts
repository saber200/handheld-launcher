/*
 * OTA 升级（用户 2026-10-12：「能不能做 ota 升级啊？每次都要重新下载，好麻烦」）。
 *
 * 走 Tauri 官方的 updater 插件，一条链路：
 *   启动后静默查一次 → 有新版就记下版本号（设置抽屉那一行显示「有新版本 vX.Y.Z」）
 *   → 用户点「更新并重启」→ 插件下载安装包、**校验签名**、静默装好 → `relaunch()` 回到新版本。
 *
 * **为什么签名这一步不能省**：更新包只认我们 CI 私钥签过的那份（公钥写死在
 * `tauri.conf.json` 的 `plugins.updater.pubkey`）。少了它，任何人往那个地址放一个安装包，
 * 掌机就会自己装上 —— 那等于把机器交出去。
 *
 * 版本检查地址：`https://github.com/saber200/fantasyhub-releases/releases/latest/download/latest.json`
 * （**公开仓只放发布物**，所以应用不登录也能读；代码仓仍然是私有的）。
 * 这里不写地址 —— 它在 `tauri.conf.json` 里，写一处。
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateState =
  /** 还没查过（或预览里不查）。 */
  | { kind: "idle" }
  | { kind: "checking" }
  /** 已是最新（带上当前版本号，好写「已是最新 v0.1.80」）。 */
  | { kind: "current"; version: string }
  /** 有新版本。 */
  | { kind: "available"; version: string; notes: string }
  /** 正在下载安装（percent 为 null = 还没拿到总大小）。 */
  | { kind: "installing"; version: string; percent: number | null }
  /** 出错了（说人话，别只说 failed）。 */
  | { kind: "failed"; reason: string };

/** 真机上才有的能力：浏览器预览里没有 updater 后端，也不该去联网。 */
export function updaterSupported(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let state: UpdateState = { kind: "idle" };
let pending: Update | null = null;
let inFlight = false;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribeUpdater(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updaterState(): UpdateState {
  return state;
}

/** 查一次版本。`silent` = 启动时那次（用户没点，所以**失败不报错**，只当没查到）。 */
export async function checkForUpdate(silent = false): Promise<void> {
  if (!updaterSupported() || inFlight) return;
  inFlight = true;
  if (!silent) set({ kind: "checking" });
  try {
    const current = await getVersion();
    const update = await check();
    if (update) {
      pending = update;
      set({ kind: "available", version: update.version, notes: update.body ?? "" });
    } else {
      pending = null;
      set({ kind: "current", version: current });
    }
  } catch (err) {
    // 启动那次静默失败**不打扰用户**（掌机可能压根没联网）：状态留在 idle，
    // 设置抽屉里那一行仍然可以手动点。
    pending = null;
    if (!silent) set({ kind: "failed", reason: String(err) });
    else set({ kind: "idle" });
  } finally {
    inFlight = false;
  }
}

/** 下载 + 安装 + 重启。中途的进度写到状态里（那一行会显示百分比）。 */
export async function installUpdate(): Promise<void> {
  if (!pending) return;
  const update = pending;
  let total = 0;
  let done = 0;
  set({ kind: "installing", version: update.version, percent: null });
  try {
    await update.downloadAndInstall((event) => {
      // 插件的进度事件：Started 给总大小、Progress 给增量、Finished 表示下载完（接下来是安装）。
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        done += event.data.chunkLength;
        set({
          kind: "installing",
          version: update.version,
          percent: total > 0 ? Math.min(99, Math.round((done / total) * 100)) : null,
        });
      }
    });
    await relaunch();
  } catch (err) {
    set({ kind: "failed", reason: String(err) });
  }
}

/**
 * 启动后**静默**查一次（`active` 由调用方给：引导没走完、或预览里就别查）。
 * 组件挂载即查一次 —— 掌机一开机就知道有没有新版，不用用户去菜单里找。
 */
export function useUpdater(active: boolean): UpdateState {
  const current = useSyncExternalStore(subscribeUpdater, updaterState);
  useEffect(() => {
    if (active) void checkForUpdate(true);
  }, [active]);
  return current;
}

/** 手动检查（设置抽屉那颗按钮）。 */
export function useManualUpdate(): [UpdateState, () => void, () => void] {
  const current = useSyncExternalStore(subscribeUpdater, updaterState);
  const recheck = useCallback(() => void checkForUpdate(false), []);
  const install = useCallback(() => void installUpdate(), []);
  return [current, recheck, install];
}
