import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<number | null>(null);
  const [toolboxOpen, setToolboxOpen] = useState(false);

  useEffect(() => {
    if (!active) return;
    firstRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (!inTauri()) {
      return;
    }
    void invoke<TdpInfo>("tdp_status")
      .then((info) => {
        setTdp(info);
        setDraft(info.watts);
        setStatus(info.message);
      })
      .catch((err) => setStatus(text().frontend.tdpFailed(String(err))));
  }, [active]);

  const applyTdp = async (watts: number) => {
    const minW = tdp?.minW ?? FALLBACK_MIN;
    const maxW = tdp?.maxW ?? FALLBACK_MAX;
    const next = Math.min(maxW, Math.max(minW, Math.round(watts)));
    setDraft(next);
    if (!inTauri()) {
      return;
    }
    setBusy(true);
    try {
      const info = await invoke<TdpInfo>("set_tdp", { watts: next });
      setTdp(info);
      setDraft(info.watts ?? next);
      setStatus(info.message);
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

  return (
    <div className="settings-body">
      <p className="frontend-lead">{m.hint}</p>
      <section className="settings-list">
        <h2 className="frontend-section-title">{m.powerTitle}</h2>
        <div className="tdp-panel">
          <div className="tdp-head">
            <strong>{m.tdp}</strong>
            <span className="tdp-watts">{m.tdpValue(display)}</span>
          </div>
          {tdp?.cpuName ? <p className="tdp-cpu">{tdp.cpuName}</p> : null}
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
          onClick={() => setToolboxOpen((open) => !open)}
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
