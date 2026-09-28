import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const FALLBACK_PRESETS = [5, 10, 15, 25, 35, 40];

export function FrontendPage({ active }: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const m = text().frontend;
  const [tdp, setTdp] = useState<TdpInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!active) return;
    firstRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (!inTauri()) {
      setStatus(text().frontend.tdpPreview);
      return;
    }
    void invoke<TdpInfo>("tdp_status")
      .then((info) => {
        setTdp(info);
        setStatus(info.message);
      })
      .catch((err) => setStatus(text().frontend.tdpFailed(String(err))));
  }, [active]);

  const applyTdp = async (watts: number) => {
    if (!inTauri()) {
      setStatus(m.tdpPreview);
      return;
    }
    setBusy(true);
    try {
      const info = await invoke<TdpInfo>("set_tdp", { watts });
      setTdp(info);
      setStatus(info.message);
    } catch (err) {
      setStatus(m.tdpFailed(String(err)));
    } finally {
      setBusy(false);
    }
  };

  const presets = tdp?.presets?.length ? tdp.presets : FALLBACK_PRESETS;
  const current = tdp?.watts ?? null;

  return (
    <div className="settings-body">
      <p className="frontend-lead">{m.hint}</p>
      <section className="settings-list">
        <h2 className="frontend-section-title">{m.powerTitle}</h2>
        <div className="tdp-panel">
          <div className="tdp-head">
            <strong>{m.tdp}</strong>
            <span className="tdp-watts">
              {current != null ? m.tdpValue(current) : m.tdpUnknown}
            </span>
          </div>
          {tdp?.cpuName ? <p className="tdp-cpu">{tdp.cpuName}</p> : null}
          <div className="tdp-presets" role="group" aria-label={m.tdp}>
            {presets.map((watts, index) => (
              <button
                key={watts}
                ref={index === 0 ? firstRef : undefined}
                type="button"
                className={`tdp-preset${current === watts ? " on" : ""}`}
                data-focusable
                disabled={busy}
                onClick={() => void applyTdp(watts)}
              >
                {watts}W
              </button>
            ))}
          </div>
          {status ? <p className="tdp-status">{status}</p> : null}
        </div>
        <button type="button" className="setting-row" data-focusable disabled>
          <span>
            <strong>{m.fan}</strong>
            <small>{m.fanBody}</small>
          </span>
          <span className="switch">{m.soon}</span>
        </button>
      </section>
      <section className="settings-list">
        <h2 className="frontend-section-title">{m.toolsTitle}</h2>
        <button type="button" className="setting-row" data-focusable disabled>
          <span>
            <strong>{m.toolbox}</strong>
            <small>{m.toolsBody}</small>
          </span>
          <span className="switch">{m.soon}</span>
        </button>
      </section>
    </div>
  );
}
