import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { text } from "../i18n";

type RuntimePackage = {
  id: string;
  name: string;
  detail: string;
  installed: boolean;
};

/** 工具箱里的前端卡片读到的安装状态（由前端自己写的记录得出）。 */
type FrontendStatus = {
  installed: boolean;
  version: string;
  exe: string;
  payload: boolean;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Toolbox tab body: runtimes + the standalone frontend installer. */
export function ToolboxPanel() {
  const m = text().frontend;
  const panelRef = useRef<HTMLDivElement>(null);
  const [runtimes, setRuntimes] = useState<RuntimePackage[]>([]);
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");
  const [frontend, setFrontend] = useState<FrontendStatus | null>(null);
  const [frontendBusy, setFrontendBusy] = useState(false);

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

  const refreshFrontend = () => {
    if (!inTauri()) return;
    void invoke<FrontendStatus>("frontend_status")
      .then(setFrontend)
      .catch(() => setFrontend(null));
  };

  useEffect(() => {
    refreshRuntimes();
    refreshFrontend();
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

  /** 安装/更新前端：只跑随包的安装包（会先请正在运行的前端自己退出）。 */
  const installFrontend = async () => {
    if (!inTauri()) {
      setNote(m.toolboxPreview);
      return;
    }
    setFrontendBusy(true);
    setNote(m.toolboxInstalling);
    try {
      setNote(await invoke<string>("frontend_install"));
      refreshFrontend();
    } catch (err) {
      setNote(m.toolboxFailed(String(err)));
    } finally {
      setFrontendBusy(false);
    }
  };

  const frontendStatus = !frontend
    ? ""
    : frontend.installed
      ? m.frontendStatusInstalled(frontend.version || "?")
      : frontend.payload
        ? m.frontendStatusMissing
        : m.frontendNoPayload;

  return (
    <div className="toolbox-panel" ref={panelRef}>
      <section className="toolbox-block">
        <h3 className="toolbox-block-title">{m.frontendTitle}</h3>
        <p className="toolbox-block-body">{m.frontendBody}</p>
        <div className="toolbox-list">
          <div className="toolbox-row">
            <span>
              <strong>{frontendStatus}</strong>
              <small>{frontend?.exe}</small>
            </span>
            <button
              type="button"
              className={`library-tool${frontend?.installed ? " on" : ""}`}
              data-focusable
              disabled={frontendBusy || frontend?.payload === false}
              onClick={() => void installFrontend()}
            >
              {frontendBusy ? m.toolboxWorking : m.frontendAction}
            </button>
          </div>
        </div>
      </section>

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
