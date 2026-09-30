// 独立前端的主面板（从 0.1.45 的 src/pages/FrontendPage.tsx 搬来）。
//
// 与旧版的三处不同：
//  1. 前端的开关不跟游戏绑定 —— 旧版那条「游戏退出就把前端收起来」属于耦合设计，
//     连同它的状态一起删掉；现在只有用户能开关。
//  2. TDP 交给 Rust 侧转发给启动器的本地 IPC（前端不提权）。
//  3. 装 TDP 驱动需要管理员，入口留在启动器的工具箱；这里只显示状态与去哪装。
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playSfx } from "../audio/sfx";
import { GAMEPAD_COMMIT } from "../hooks/useGamepadNav";
import { text } from "../i18n";
import { quitGame, useRunningGame } from "./library";

type TdpInfo = {
  vendor: string;
  cpuName: string;
  minW: number;
  maxW: number;
  watts: number | null;
  presets: number[];
  supported: boolean;
  backend: string;
  message: string;
};

type TdpDriverStatus = {
  ready: boolean;
  elevated: boolean;
  installed?: boolean;
  message: string;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const FALLBACK_PRESETS = [5, 10, 15, 25, 35, 40];
const FALLBACK_MIN = 5;
const FALLBACK_MAX = 40;

// 按着方向键时驱动的响应跟不上，写入按 260 ms 合并：只保留最新值，不排队。
const TDP_WRITE_DELAY_MS = 260;

export function FrontendPanel({ active }: { active: boolean }) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const m = text().frontend;
  const [tdp, setTdp] = useState<TdpInfo | null>(null);
  const [driver, setDriver] = useState<TdpDriverStatus | null>(null);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<number | null>(null);
  const [quitting, setQuitting] = useState(false);
  const [probe, refreshRunningGame] = useRunningGame(active);
  const runningGame = probe.game;
  const writeTimer = useRef<number | null>(null);
  const writing = useRef(false);
  const pending = useRef<number | null>(null);

  const refreshDriver = () => {
    if (!inTauri()) {
      setDriver({ ready: true, elevated: true, installed: true, message: m.tdpPreview });
      return;
    }
    void invoke<TdpDriverStatus>("toolbox_tdp_driver_status")
      .then(setDriver)
      // 拿不到状态通常是启动器没在跑：说清楚，别让人以为前端坏了。
      .catch(() =>
        setDriver({
          ready: false,
          elevated: false,
          installed: false,
          message: m.tdpNoLauncher,
        }),
      );
  };

  const refreshTdp = () => {
    if (!inTauri()) return;
    void invoke<TdpInfo>("tdp_status")
      .then((info) => {
        setTdp(info);
        setDraft(info.watts);
        setStatus(info.message);
      })
      .catch((err) => setStatus(m.tdpFailed(String(err))));
  };

  useEffect(() => {
    if (!active) return;
    firstRef.current?.focus();
  }, [active, driver?.ready]);

  useEffect(() => {
    if (!active) return;
    refreshDriver();
  }, [active]);

  useEffect(() => {
    if (!active || !driver?.ready) return;
    refreshTdp();
  }, [active, driver?.ready]);

  const clampTdp = (watts: number) => {
    const min = tdp?.minW ?? FALLBACK_MIN;
    const max = tdp?.maxW ?? FALLBACK_MAX;
    return Math.min(max, Math.max(min, Math.round(watts)));
  };

  const writeTdp = async (watts: number) => {
    if (!inTauri()) return;
    writing.current = true;
    try {
      const info = await invoke<TdpInfo>("set_tdp", { watts });
      setTdp(info);
      setDraft(info.watts ?? watts);
      setStatus(info.message);
      playSfx("done");
    } catch (err) {
      setStatus(m.tdpFailed(String(err)));
    } finally {
      writing.current = false;
    }
  };

  const drainTdp = async () => {
    if (writing.current) return;
    const next = pending.current;
    if (next === null) return;
    pending.current = null;
    await writeTdp(next);
    // 手可能还按着：把期间到达的值补上。
    if (pending.current !== null) void drainTdp();
  };

  const queueTdp = (watts: number, delay: number) => {
    pending.current = clampTdp(watts);
    setDraft(pending.current);
    if (writing.current) return;
    if (delay <= 0) {
      void drainTdp();
      return;
    }
    if (writeTimer.current !== null) return;
    writeTimer.current = window.setTimeout(() => {
      writeTimer.current = null;
      void drainTdp();
    }, delay);
  };

  const flushTdp = () => {
    if (writeTimer.current !== null) {
      window.clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    void drainTdp();
  };
  const flushRef = useRef(flushTdp);
  flushRef.current = flushTdp;

  // 焦点在滑条上时按 A 立即提交（见 useGamepadNav 的 confirmFocused）。
  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    const commit = () => flushRef.current();
    slider.addEventListener(GAMEPAD_COMMIT, commit);
    return () => slider.removeEventListener(GAMEPAD_COMMIT, commit);
  }, [driver?.ready]);

  // 调完就关也不丢最后一次值。
  useEffect(
    () => () => {
      if (writeTimer.current !== null) window.clearTimeout(writeTimer.current);
      const last = pending.current;
      pending.current = null;
      if (last !== null && inTauri()) {
        void invoke("set_tdp", { watts: last }).catch(() => {});
      }
    },
    [],
  );

  const applyTdp = (watts: number) => {
    playSfx("click");
    queueTdp(watts, 0);
  };

  // 滑块一步一个音：升 = tdp-up、降 = tdp-down（手柄推方向键走的是同一个入口）。
  // 基准取「还没落盘的最新值」，快速拖动时不会因为 React 还没重渲染就判错方向。
  const stepTdp = (watts: number) => {
    const next = clampTdp(watts);
    const prev = pending.current ?? display;
    if (next > prev) playSfx("tdpUp");
    else if (next < prev) playSfx("tdpDown");
    queueTdp(next, TDP_WRITE_DELAY_MS);
  };

  const quitRunning = async () => {
    if (!runningGame || quitting) return;
    playSfx("click");
    setQuitting(true);
    setStatus(await quitGame(runningGame));
    setQuitting(false);
    refreshRunningGame();
  };

  const presets = tdp?.presets?.length ? tdp.presets : FALLBACK_PRESETS;
  const minW = tdp?.minW ?? FALLBACK_MIN;
  const maxW = tdp?.maxW ?? FALLBACK_MAX;
  const current = tdp?.watts ?? null;
  const display = draft ?? current ?? minW;
  const driverReady = Boolean(driver?.ready);

  return (
    <div className="frontend-panel-body settings-body">
      <section className="settings-list">
        <h2 className="frontend-section-title">{m.powerTitle}</h2>
        <div className="tdp-panel">
          <div className="tdp-head">
            <strong>{m.tdp}</strong>
            {driverReady ? (
              <span className="tdp-watts">{m.tdpValue(display)}</span>
            ) : (
              <span className="tdp-watts">{m.tdpUnknown}</span>
            )}
          </div>
          {tdp?.cpuName && driverReady ? <p className="tdp-cpu">{tdp.cpuName}</p> : null}

          {!driverReady ? (
            <>
              <p className="toolbox-block-body">{m.tdpDriverBody}</p>
              <p className="tdp-status">{driver?.message || m.tdpNoLauncher}</p>
              {/* 装驱动要管理员，入口在启动器的工具箱 —— 前端不替任何人装内核驱动。 */}
              <p className="tdp-status">{m.tdpDriverInLauncher}</p>
            </>
          ) : (
            <>
              <div className="tdp-presets" role="group" aria-label={m.tdp}>
                {presets.map((watts, index) => (
                  <button
                    key={watts}
                    ref={index === 0 ? firstRef : undefined}
                    type="button"
                    className={`tdp-preset${display === watts ? " on" : ""}`}
                    data-focusable
                    onClick={() => applyTdp(watts)}
                  >
                    {watts}W
                  </button>
                ))}
              </div>
              <label className="tdp-slider-row">
                <span className="tdp-slider-label">{m.tdpSlider}</span>
                <input
                  ref={sliderRef}
                  type="range"
                  className="tdp-slider"
                  min={minW}
                  max={maxW}
                  step={1}
                  value={display}
                  data-focusable
                  aria-label={m.tdpSlider}
                  onInput={(e) => stepTdp(Number(e.currentTarget.value))}
                />
                <span className="tdp-slider-ends">
                  <span>{minW}W</span>
                  <span>{maxW}W</span>
                </span>
              </label>
            </>
          )}
          {status ? <p className="tdp-status">{status}</p> : null}
        </div>
        <button type="button" className="setting-row" data-focusable disabled>
          <span>
            <strong>{m.fan}</strong>
          </span>
          <span className="switch">{m.later}</span>
        </button>
        {/* 只有库里的**游戏**才有这行：软件和启动器本身没什么可退的。 */}
        {runningGame ? (
          <button
            type="button"
            className="setting-row"
            data-focusable
            onClick={() => void quitRunning()}
          >
            <span>
              <strong>{quitting ? m.quitGameRunning : m.quitGame}</strong>
              <small>{m.quitGameBody(runningGame.name)}</small>
            </span>
            <span className="switch">{quitting ? m.toolboxWorking : m.quitGame}</span>
          </button>
        ) : null}
      </section>
    </div>
  );
}
