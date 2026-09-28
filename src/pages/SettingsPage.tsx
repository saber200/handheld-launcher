import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { text, useI18n } from "../i18n";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Props = { active: boolean };

let dismissPower: (() => boolean) | null = null;

export function closePowerMenu(): boolean {
  return dismissPower?.() ?? false;
}

export function SettingsPage({ active }: Props) {
  const { locale, setLocale } = useI18n();
  const m = text().settings;
  const firstRef = useRef<HTMLButtonElement>(null);
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [fse, setFse] = useState("");
  const [isTauri, setIsTauri] = useState(false);
  const [powerOpen, setPowerOpen] = useState(false);
  const sleepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const tauri = inTauri();
    setIsTauri(tauri);
    if (!tauri) return;
    void invoke<boolean>("autostart_enabled")
      .then(setAutostart)
      .catch(() => setMessage(text().settings.autostartReadFailed));
    void invoke<string>("fse_status")
      .then(setFse)
      .catch(() => setFse(text().settings.fsePreview));
  }, []);

  useEffect(() => {
    if (!active) {
      setPowerOpen(false);
      return;
    }
    firstRef.current?.focus();
  }, [active]);

  useEffect(() => {
    dismissPower = () => {
      if (!powerOpen) return false;
      setPowerOpen(false);
      return true;
    };
    return () => {
      dismissPower = null;
    };
  }, [powerOpen]);

  useEffect(() => {
    if (powerOpen) sleepRef.current?.focus();
  }, [powerOpen]);

  const toggleAutostart = async () => {
    if (!isTauri) {
      setMessage(text().settings.autostartPreview);
      return;
    }
    setBusy(true);
    try {
      await invoke("set_autostart", { enabled: !autostart });
      const on = await invoke<boolean>("autostart_enabled");
      setAutostart(on);
      setMessage(
        on
          ? text().settings.autostartOn
          : text().settings.autostartOff,
      );
    } catch (e) {
      setMessage(text().settings.autostartFailed(String(e)));
    } finally {
      setBusy(false);
    }
  };

  const enterFullscreen = async () => {
    if (!isTauri) {
      setMessage(text().settings.fullscreenPreview);
      return;
    }
    try {
      await invoke("enter_fullscreen");
      setMessage(text().settings.fullscreenDone);
    } catch (e) {
      setMessage(text().settings.fullscreenFailed(String(e)));
    }
  };

  const openDesktop = async () => {
    if (!isTauri) {
      setMessage(text().settings.desktopPreview);
      return;
    }
    try {
      await invoke("open_desktop");
      setMessage(text().settings.desktopDone);
    } catch (e) {
      setMessage(text().settings.desktopFailed(String(e)));
    }
  };

  const registerFse = async () => {
    if (!isTauri) {
      setMessage(text().settings.fsePreview);
      return;
    }
    setBusy(true);
    try {
      const status = await invoke<string>("register_fse");
      setFse(status);
      setMessage(status);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openFseSettings = async () => {
    if (!isTauri) {
      setMessage(text().settings.fsePreview);
      return;
    }
    try {
      await invoke("open_fse_settings");
    } catch (e) {
      setMessage(text().settings.fseOpenFailed(String(e)));
    }
  };

  const quitApp = async () => {
    if (!isTauri) {
      window.close();
      return;
    }
    try {
      await invoke("quit_launcher");
    } catch (e) {
      setMessage(String(e));
    }
  };

  const runPower = async (action: "sleep" | "restart" | "shutdown") => {
    setPowerOpen(false);
    if (!isTauri) {
      setMessage(text().settings.powerPreview);
      return;
    }
    try {
      await invoke("system_power", { action });
      if (action === "sleep") setMessage(text().settings.slept);
    } catch (e) {
      setMessage(text().settings.powerFailed(String(e)));
    }
  };

  return (
    <div className="settings-body">
      <section className="settings-list">
        <div className="setting-row">
          <span>
            <strong>{m.language}</strong>
          </span>
          <span className="lang-switch">
            <button
              type="button"
              className={locale === "zh" ? "switch on" : "switch"}
              data-focusable
              onClick={() => setLocale("zh")}
            >
              中文
            </button>
            <button
              type="button"
              className={locale === "en" ? "switch on" : "switch"}
              data-focusable
              onClick={() => setLocale("en")}
            >
              English
            </button>
          </span>
        </div>

        <button
          ref={firstRef}
          type="button"
          className="setting-row"
          data-focusable
          disabled={busy}
          onClick={() => void toggleAutostart()}
        >
          <span>
            <strong>{m.autostart}</strong>
            <small>{m.autostartHint}</small>
          </span>
          <span className={`switch ${autostart ? "on" : ""}`}>
            {autostart ? m.on : m.off}
          </span>
        </button>

        <button
          type="button"
          className="setting-row"
          data-focusable
          disabled={busy}
          onClick={() => void enterFullscreen()}
        >
          <span>
            <strong>{m.fullscreen}</strong>
            <small>{m.fullscreenHint}</small>
          </span>
          <span className="chev">▣</span>
        </button>

        <button type="button" className="setting-row" data-focusable onClick={() => void openDesktop()}>
          <span>
            <strong>{m.desktop}</strong>
            <small>{m.desktopHint}</small>
          </span>
          <span className="chev">⌂</span>
        </button>

        <div className="setting-row">
          <span>
            <strong>{m.fse}</strong>
            <small>{fse || m.fseHint}</small>
          </span>
        </div>

        <button
          type="button"
          className="setting-row"
          data-focusable
          disabled={busy}
          onClick={() => void registerFse()}
        >
          <span>
            <strong>{m.fseRegister}</strong>
            <small>{m.fseRegisterHint}</small>
          </span>
          <span className="chev">⟳</span>
        </button>

        <button
          type="button"
          className="setting-row"
          data-focusable
          onClick={() => void openFseSettings()}
        >
          <span>
            <strong>{m.fseOpenSettings}</strong>
            <small>{m.fseOpenSettingsHint}</small>
          </span>
          <span className="chev">↗</span>
        </button>

        <button
          type="button"
          className="setting-row danger"
          data-focusable
          onClick={() => void quitApp()}
        >
          <span>
            <strong>{m.quit}</strong>
            <small>{m.quitHint}</small>
          </span>
          <span className="chev">⏻</span>
        </button>
      </section>

      {message && <p className="status-msg">{message}</p>}

      <div className="settings-foot">
        <p className="about-line">{text().about}</p>
        <div className="power-menu">
          {powerOpen && (
            <div className="power-options" role="menu" aria-label={text().power.menu}>
              <button ref={sleepRef} type="button" className="power-option" data-focusable onClick={() => void runPower("sleep")}>
                {text().power.sleep}
              </button>
              <button type="button" className="power-option" data-focusable onClick={() => void runPower("restart")}>
                {text().power.restart}
              </button>
              <button type="button" className="power-option danger" data-focusable onClick={() => void runPower("shutdown")}>
                {text().power.shutdown}
              </button>
            </div>
          )}
          <button
            type="button"
            className="power-toggle"
            data-focusable
            aria-label={text().power.menu}
            aria-expanded={powerOpen}
            onClick={() => setPowerOpen((open) => !open)}
          >
            ⏻
          </button>
        </div>
      </div>
    </div>
  );
}
