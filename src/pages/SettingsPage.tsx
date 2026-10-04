import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { text, useI18n } from "../i18n";
import { playSwitch } from "../audio/sfx";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Props = { active: boolean; onClose: () => void };

let dismissPower: (() => boolean) | null = null;

export function closePowerMenu(): boolean {
  return dismissPower?.() ?? false;
}

export function SettingsPage({ active, onClose }: Props) {
  const { locale, setLocale } = useI18n();
  const m = text().settings;
  const firstRef = useRef<HTMLButtonElement>(null);
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isTauri, setIsTauri] = useState(false);
  // Game Bar 小组件上次装的结果（启动器每次启动都会自动装一次），显示在那一行下面。
  const [widgetStatus, setWidgetStatus] = useState("");
  const [powerOpen, setPowerOpen] = useState(false);
  const sleepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const tauri = inTauri();
    setIsTauri(tauri);
    if (!tauri) return;
    void invoke<boolean>("autostart_enabled")
      .then(setAutostart)
      .catch(() => setMessage(text().settings.autostartReadFailed));
    void invoke<string>("widget_status")
      .then(setWidgetStatus)
      .catch(() => setWidgetStatus(""));
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
      playSwitch(on);
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

  const registerFse = async () => {
    if (!isTauri) {
      setMessage(text().settings.fsePreview);
      return;
    }
    setBusy(true);
    try {
      const status = await invoke<string>("register_fse");
      setMessage(status);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const installWidget = async () => {
    if (!isTauri) {
      setMessage(text().settings.widgetPreview);
      return;
    }
    setBusy(true);
    try {
      // force：设置页点一次就是要"重装一遍"，已经装好也会先卸再装。
      const status = await invoke<string>("register_widget");
      setMessage(status);
      setWidgetStatus(status);
    } catch (e) {
      setMessage(String(e));
      setWidgetStatus(String(e));
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


  // 「关于」那一行的版本号：问 Tauri 要（拿不到就只写产品名 —— 不编一个版本号出来）
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (!inTauri()) return;
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);
  const about = version ? `${text().productName} ${version}` : text().productName;

  return (
    <div className="settings-body">
      {/* K3 标题行：标题 21dp Bold + 「双击 Back 呼出 · Esc 关闭」10dp + 关闭按钮 34×34 */}
      <div className="k3-head">
        <h2>{m.title}</h2>
        <p className="k3-head-note">{m.panelSub}</p>
        <button type="button" className="k3-close" data-focusable aria-label={m.close} onClick={onClose}>
          ✕
        </button>
      </div>

      <section className="k3-list">
        {/* 语言：两片小按钮（画板那一行写的是「简体中文」，这里给的是能按的控件 —— 手柄上
            没有下拉框，二选一按一下最省事） */}
        <div className="k3-row">
          <span className="k3-text">
            <strong>{m.language}</strong>
            <small>{m.languageHint}</small>
          </span>
          <span className="k3-control">
            <span className="k3-seg" role="group" aria-label={m.language}>
              <button
                type="button"
                className={locale === "zh" ? "k3-seg-item on" : "k3-seg-item"}
                data-focusable
                aria-pressed={locale === "zh"}
                onClick={() => {
                  if (locale === "zh") return;
                  playSwitch(true);
                  setLocale("zh");
                }}
              >
                中文
              </button>
              <button
                type="button"
                className={locale === "en" ? "k3-seg-item on" : "k3-seg-item"}
                data-focusable
                aria-pressed={locale === "en"}
                onClick={() => {
                  if (locale === "en") return;
                  playSwitch(true);
                  setLocale("en");
                }}
              >
                English
              </button>
            </span>
          </span>
        </div>

        <button
          ref={firstRef}
          type="button"
          className="k3-row"
          data-focusable
          disabled={busy}
          aria-pressed={autostart}
          onClick={() => void toggleAutostart()}
        >
          <span className="k3-text">
            <strong>{m.autostart}</strong>
            <small>{m.autostartHint}</small>
          </span>
          <span className="k3-control">
            <span className={autostart ? "k3-switch on" : "k3-switch"} aria-hidden>
              <span className="k3-switch-knob" />
            </span>
          </span>
        </button>

        <button
          type="button"
          className="k3-row"
          data-focusable
          disabled={busy}
          onClick={() => void registerFse()}
        >
          <span className="k3-text">
            <strong>{m.fseRegister}</strong>
            <small>{m.fseRegisterHint}</small>
          </span>
          <span className="k3-control">
            <span className="k3-value" aria-hidden>
              ⟳
            </span>
          </span>
        </button>

        <button type="button" className="k3-row" data-focusable onClick={() => void openFseSettings()}>
          <span className="k3-text">
            <strong>{m.fseOpenSettings}</strong>
            <small>{m.fseOpenSettingsHint}</small>
          </span>
          <span className="k3-control">
            <span className="k3-value" aria-hidden>
              ↗
            </span>
          </span>
        </button>

        <button
          type="button"
          className="k3-row"
          data-focusable
          disabled={busy}
          onClick={() => void installWidget()}
        >
          <span className="k3-text">
            <strong>{m.widgetRegister}</strong>
            <small>{widgetStatus || m.widgetRegisterHint}</small>
          </span>
          <span className="k3-control">
            <span className="k3-value" aria-hidden>
              ⟳
            </span>
          </span>
        </button>

        <button type="button" className="k3-row" data-focusable onClick={() => void quitApp()}>
          <span className="k3-text">
            <strong>{m.quit}</strong>
            <small>{m.quitHint}</small>
          </span>
          <span className="k3-control">
            <span className="k3-value" aria-hidden>
              ⏻
            </span>
          </span>
        </button>

        {/* 关于：真版本号（Tauri 的 getVersion）；拿不到就只写产品名 */}
        <div className="k3-row">
          <span className="k3-text">
            <strong>{m.aboutTitle}</strong>
            <small>{m.aboutStack}</small>
          </span>
          <span className="k3-control">
            <span className="k3-value tnum">{about}</span>
          </span>
        </div>
      </section>

      {message && <p className="status-msg">{message}</p>}

      <div className="k3-foot">
        <p className="about-line">{text().about}</p>
        <p className="k3-keys">{m.panelKeys}</p>
        <div className="k3-power">
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
            className="k3-action"
            data-focusable
            aria-label={text().power.menu}
            aria-expanded={powerOpen}
            onClick={() => {
              setPowerOpen((open) => {
                playSwitch(!open);
                return !open;
              });
            }}
          >
            ⏻ {text().power.menu}
          </button>
        </div>
      </div>
    </div>
  );
}
