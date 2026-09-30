// 独立前端的「库 + 运行中游戏」。
//
// 清单来自启动器发布的 `library.json`（只读），进程判断与「退出游戏」由本程序自己
// 完成（枚举进程、结束进程都不需要提权）—— 所以启动器没在运行也能用，这正是解耦的意义。
// 与前端的 localStorage 无关：那是启动器的缓存，两个程序的 WebView2 目录是分开的。
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { text } from "../i18n";

export type FrontendGame = {
  id: string;
  name: string;
  launchPath?: string;
  installPath?: string;
};

export type RunningProbe = {
  game: FrontendGame | null;
  /** 本次探测是否拿到了可用答复（空结果也算答复）。 */
  settled: boolean;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 探测间隔：与旧版浮层一致，够快也不折腾 CPU。 */
const PROBE_INTERVAL_MS = 4000;

/** 启动器发布的库清单；读不到（启动器还没发布过）就是空表。 */
export async function readLibrary(): Promise<FrontendGame[]> {
  if (!inTauri()) return [];
  return invoke<FrontendGame[]>("library_read").catch(() => []);
}

/**
 * 库里正在运行的游戏。只在浮层可见时才探测；一次只跑一个探测，但会记住期间的再次
 * 请求（点完「退出游戏」要立刻看到结果，不能等下一个心跳）。
 */
export function useRunningGame(active: boolean): [RunningProbe, () => void] {
  const [games, setGames] = useState<FrontendGame[]>([]);
  const [probe, setProbe] = useState<RunningProbe>({ game: null, settled: false });
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const probes = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active || !inTauri()) return;
    let cancel = false;
    void readLibrary().then((list) => {
      if (!cancel) setGames(list);
    });
    return () => {
      cancel = true;
    };
  }, [active]);

  const tick = useCallback(() => {
    if (games.length === 0) {
      setProbe({ game: null, settled: true });
      return;
    }
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    void invoke<string[]>("running_games", {
      items: games.map((game) => ({
        id: game.id,
        launchPath: game.launchPath ?? "",
        installPath: game.installPath ?? "",
      })),
    })
      .then((ids) => setProbe({ game: games.find((game) => ids.includes(game.id)) ?? null, settled: true }))
      // 探测失败不等于游戏退出了：保持上一次的答案。
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
        if (rerun.current) {
          rerun.current = false;
          probes.current();
        }
      });
  }, [games]);
  probes.current = tick;

  useEffect(() => {
    if (!active || games.length === 0) return;
    tick();
    const timer = window.setInterval(tick, PROBE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, games.length, tick]);

  return [probe, tick];
}

/** 退出游戏：本程序自己结束进程，文案与启动器里那套保持一致。 */
export async function quitGame(game: FrontendGame): Promise<string> {
  if (!inTauri()) return text().library.previewLaunch;
  try {
    await invoke<number>("quit_game", {
      id: game.id,
      launchPath: game.launchPath ?? "",
      installPath: game.installPath ?? "",
    });
    return text().library.quitGameDone(game.name);
  } catch (err) {
    const detail = typeof err === "string" ? err : err instanceof Error ? err.message : "";
    if (detail.includes("没有找到") || detail.toLowerCase().includes("no running")) {
      return text().library.quitGameNotRunning(game.name);
    }
    return text().library.quitGameFailed(game.name, detail || text().library.failed);
  }
}
