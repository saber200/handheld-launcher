import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playSfx, playSwitch, startLoadingSfx, stopLoadingSfx } from "../audio/sfx";
import { text } from "../i18n";
import { ToolboxPanel } from "./ToolboxPanel";

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

export function FrontendPage({ active }: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const m = text().frontend;
  const [tdp, setTdp] = useState<TdpInfo | null>(null);
  const [driver, setDriver] = useState<TdpDriverStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [driverBusy, setDriverBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<number | null>(null);
  const [toolboxOpen, setToolboxOpen] = useState(false);

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

  const applyTdp = async (watts: number) => {
    const minW = tdp?.minW ?? FALLBACK_MIN;
    const maxW = tdp?.maxW ?? FALLBACK_MAX;
    const next = Math.min(maxW, Math.max(minW, Math.round(watts)));
    setDraft(next);
    playSfx("click");
    if (!inTauri()) {
      return;
    }
    setBusy(true);
    try {
      const info = await invoke<TdpInfo>("set_tdp", { watts: next });
      setTdp(info);
      setDraft(info.watts ?? next);
      setStatus(info.message);
      playSfx("done");
    } catch (err) {
      setStatus(m.tdpFailed(String(err)));
    } finally {
      setBusy(false);
    }
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
                    disabled={busy}
                    onClick={() => void applyTdp(watts)}
                  >
                    {watts}W
                  </button>
                ))}
              </div>
              <label className="tdp-slider-row">
                <span className="tdp-slider-label">{m.tdpSlider}</span>
                <input
                  type="range"
                  className="tdp-slider"
                  min={minW}
                  max={maxW}
                  step={1}
                  value={display}
                  data-focusable
                  disabled={busy}
                  aria-label={m.tdpSlider}
                  onInput={(e) => setDraft(Number(e.currentTarget.value))}
                  onChange={(e) => void applyTdp(Number(e.currentTarget.value))}
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
      </section>
      <section className="settings-list">
        <h2 className="frontend-section-title">{m.toolsTitle}</h2>
        <button
          type="button"
          className="setting-row"
          data-focusable
          onClick={() => {
            setToolboxOpen((open) => {
              playSwitch(!open);
              return !open;
            });
          }}
        >
          <span>
            <strong>{m.toolbox}</strong>
          </span>
          <span className={`switch${toolboxOpen ? " on" : ""}`}>
            {toolboxOpen ? m.toolboxHide : m.toolboxShow}
          </span>
        </button>
        {toolboxOpen ? <ToolboxPanel active={active && toolboxOpen} /> : null}
      </section>
    </div>
  );
}
