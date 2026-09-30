import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playSfx, startLoadingSfx, stopLoadingSfx } from "../audio/sfx";
import { GAMEPAD_COMMIT } from "../hooks/useGamepadNav";
import { quitLibraryGame, useRunningLibraryGame } from "../library/useLocalLibrary";
import { text } from "../i18n";

type Props = { active: boolean };

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

/// A held D-pad steps faster than the driver answers, so writes are coalesced:
/// the newest value wins and nothing stacks up behind the running one.
const TDP_WRITE_DELAY_MS = 260;

export function FrontendPage({ active }: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const m = text().frontend;
  const [tdp, setTdp] = useState<TdpInfo | null>(null);
  const [driver, setDriver] = useState<TdpDriverStatus | null>(null);
  const [driverBusy, setDriverBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<number | null>(null);
  const [quitting, setQuitting] = useState(false);
  const [runningGame, refreshRunningGame] = useRunningLibraryGame(active);
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
      .catch((err) => setStatus(m.toolboxFailed(String(err))));
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

  const installDriver = async () => {
    if (!inTauri()) {
      setStatus(m.tdpPreview);
      return;
    }
    setDriverBusy(true);
    const already = Boolean(driver?.installed);
    setStatus(already ? m.tdpDriverStarting : m.tdpDriverInstalling);
    startLoadingSfx();
    try {
      const next = await invoke<TdpDriverStatus>("toolbox_install_tdp_driver");
      setDriver(next);
      setStatus(next.message);
      stopLoadingSfx(next.ready);
      if (next.ready) refreshTdp();
    } catch (err) {
      stopLoadingSfx(false);
      setStatus(m.toolboxFailed(String(err)));
      refreshDriver();
    } finally {
      setDriverBusy(false);
    }
  };

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
    // The button is probably still held: write what arrived while we were busy.
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

  // A on the focused slider commits right away (see confirmFocused in useGamepadNav).
  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    const commit = () => flushRef.current();
    slider.addEventListener(GAMEPAD_COMMIT, commit);
    return () => slider.removeEventListener(GAMEPAD_COMMIT, commit);
  }, [driver?.ready]);

  // Stepping and then closing the panel still has to keep the last value.
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

  const stepTdp = (watts: number) => {
    playSfx("click");
    queueTdp(watts, TDP_WRITE_DELAY_MS);
  };

  const quitRunningGame = async () => {
    if (!runningGame || quitting) return;
    playSfx("click");
    setQuitting(true);
    const message = await quitLibraryGame({
      id: runningGame.id,
      name: runningGame.name,
      launchPath: runningGame.launchPath,
      installPath: runningGame.installPath,
      customPath: runningGame.customPath,
    });
    setStatus(message);
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
    <div className="settings-body">
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
              {driver ? <p className="tdp-status">{driver.message}</p> : null}
              <button
                ref={firstRef}
                type="button"
                className="setting-row"
                data-focusable
                disabled={driverBusy}
                onClick={() => void installDriver()}
                style={{ marginTop: "10px" }}
              >
                <span>
                  <strong>
                    {driver?.installed ? m.tdpDriverStart : m.tdpDriverInstall}
                  </strong>
                  <small>
                    {driver && !driver.elevated
                      ? m.tdpDriverNeedAdmin
                      : driver?.installed
                        ? m.tdpDriverStart
                        : m.tdpDriverInstall}
                  </small>
                </span>
                <span className="switch">
                  {driverBusy
                    ? m.toolboxWorking
                    : driver?.installed
                      ? m.tdpDriverStart
                      : m.toolboxInstall}
                </span>
              </button>
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
        {/* Only a library *game* gets this row: apps and the shell have nothing
            to kill, and the overlay should get you out of a game without
            hunting for the task manager. */}
        {runningGame ? (
          <button
            type="button"
            className="setting-row"
            data-focusable
            onClick={() => void quitRunningGame()}
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
