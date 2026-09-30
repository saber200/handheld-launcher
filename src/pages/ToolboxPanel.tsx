import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { text } from "../i18n";

type RuntimePackage = {
  id: string;
  name: string;
  detail: string;
  installed: boolean;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Toolbox tab body: runtimes only. Per-game OptiScaler lives on the game card menu. */
export function ToolboxPanel() {
  const m = text().frontend;
  const panelRef = useRef<HTMLDivElement>(null);
  const [runtimes, setRuntimes] = useState<RuntimePackage[]>([]);
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");

  const refreshRuntimes = () => {
    if (!inTauri()) {
      setRuntimes([]);
      setNote(m.toolboxPreview);
      return;
    }
    void invoke<RuntimePackage[]>("toolbox_runtimes")
      .then(setRuntimes)
      .catch((err) => setNote(m.toolboxFailed(String(err))));
  };

  useEffect(() => {
    refreshRuntimes();
  }, []);

  useEffect(() => {
    // Mounts fresh on each tab switch: give gamepad navigation a starting point.
    panelRef.current?.querySelector<HTMLElement>("[data-focusable]")?.focus();
  }, []);

  const installRuntime = async (id: string) => {
    if (!inTauri()) {
      setNote(m.toolboxPreview);
      return;
    }
    setBusyId(id);
    setNote(m.toolboxInstalling);
    try {
      const message = await invoke<string>("toolbox_install_runtime", { id });
      setNote(message);
      refreshRuntimes();
    } catch (err) {
      setNote(m.toolboxFailed(String(err)));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="toolbox-panel" ref={panelRef}>
      <section className="toolbox-block">
        <h3 className="toolbox-block-title">{m.runtimesTitle}</h3>
        <p className="toolbox-block-body">{m.runtimesBody}</p>
        {runtimes.length === 0 && inTauri() ? (
          <p className="tdp-status">{m.runtimesEmpty}</p>
        ) : null}
        <div className="toolbox-list">
          {runtimes.map((pkg) => (
            <div key={pkg.id} className="toolbox-row">
              <span>
                <strong>{pkg.name}</strong>
                <small>{pkg.detail}</small>
              </span>
              <button
                type="button"
                className={`library-tool${pkg.installed ? " on" : ""}`}
                data-focusable
                disabled={busyId !== ""}
                onClick={() => void installRuntime(pkg.id)}
              >
                {busyId === pkg.id
                  ? m.toolboxWorking
                  : pkg.installed
                    ? m.toolboxReinstall
                    : m.toolboxInstall}
              </button>
            </div>
          ))}
        </div>
      </section>

      {note ? <p className="tdp-status">{note}</p> : null}
    </div>
  );
}
