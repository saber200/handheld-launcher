import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { text, useI18n } from "../i18n";
import { playSwitch } from "../audio/sfx";
import {
  DEADZONE_CHOICES,
  SCALE_CHOICES,
  setPrefs,
  usePrefs,
} from "../settings/prefs";
import { autoUiScale } from "../styles/scale";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** `tdp_status` 里设置页要用的字段（形状在共享内核 fh-core::tdp）。 */
type TdpInfo = {
  minW: number;
  maxW: number;
  watts: number | null;
  presets: number[];
  supported: boolean;
  message: string;
};

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
  /** 界面缩放 + 手柄死区（纯前端偏好，localStorage）。 */
  const prefsNow = usePrefs();
  /** 当前功耗（`tdp_status`）。null = 还没读到；读不到就写「—」，不写假数字。 */
  const [tdp, setTdp] = useState<TdpInfo | null>(null);
  const [tdpBusy, setTdpBusy] = useState(false);

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
    // 当前功耗：拿不到就是 null，那一行写「—」（不猜一个瓦数）。
    void invoke<TdpInfo>("tdp_status")
      .then(setTdp)
      .catch(() => setTdp(null));
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

  /** 界面缩放那一行的读数：自动算出来的倍率 × 用户系数。 */
  const autoScale = autoUiScale(window.innerWidth, window.innerHeight);
  const scaleReadout =
    prefsNow.scale === 1
      ? m.scaleAuto(autoScale.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""))
      : m.scaleManual(
          String(prefsNow.scale),
          (autoScale * prefsNow.scale).toFixed(2),
        );

  /** 功耗档位：预设来自后端（5/10/15/25/35/40），没有预设就退回 min..max 两个端点。 */
  const presets = tdp?.presets?.length ? tdp.presets : [tdp?.minW ?? 5, tdp?.maxW ?? 40];
  const wattsText = tdp?.watts != null ? m.powerValue(String(tdp.watts)) : "—";

  /**
   * 调一档功耗（+1 / -1 走预设表）。
   *
   * 为什么按预设走而不是 ±1 W：后端定义的就是这几档（`tdp.rs` 的 PRESETS），
   * 自己插值出来的瓦数没有经过验证，写进 MSR 未必被接受。
   */
  const stepTdp = async (dir: -1 | 1) => {
    if (!isTauri) {
      setMessage(text().settings.powerPreview);
      return;
    }
    if (!tdp || tdp.watts == null) return;
    const index = presets.indexOf(tdp.watts);
    const next = presets[index + dir];
    if (next == null || Number.isNaN(next)) return;
    setTdpBusy(true);
    try {
      const info = await invoke<TdpInfo>("set_tdp", { watts: next });
      setTdp(info);
      playSwitch(true);
      setMessage(info.message);
    } catch (e) {
      setMessage(text().settings.powerFailed(String(e)));
    } finally {
      setTdpBusy(false);
    }
  };

  /** 手柄死区：预设四档，按档走。 */
  const stepDeadzone = (dir: -1 | 1) => {
    const index = DEADZONE_CHOICES.indexOf(
      prefsNow.deadzone as (typeof DEADZONE_CHOICES)[number],
    );
    const next = DEADZONE_CHOICES[Math.max(0, Math.min(DEADZONE_CHOICES.length - 1, index + dir))];
    if (next != null) {
      setPrefs({ deadzone: next });
      playSwitch(true);
    }
  };

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

        {/* ── 功能 14 第 5 条补的三行（画板 K3 上就是这三行） ──
            界面缩放 / 性能与功耗 / 手柄死区。前两项是纯前端偏好（localStorage），
            功耗走启动器已有的 `set_tdp`（前端只读，真正写 MSR 在提权的启动器侧）。 */}

        <div className="k3-row">
          <span className="k3-text">
            <strong>{m.scaleTitle}</strong>
            <small>
              {m.scaleHint} · {scaleReadout}
            </small>
          </span>
          <span className="k3-control">
            <span className="k3-seg" role="group" aria-label={m.scaleTitle}>
              {SCALE_CHOICES.map((value, index) => (
                <button
                  key={value}
                  type="button"
                  className={prefsNow.scale === value ? "k3-seg-item on" : "k3-seg-item"}
                  data-focusable
                  aria-pressed={prefsNow.scale === value}
                  onClick={() => {
                    if (prefsNow.scale === value) return;
                    playSwitch(true);
                    setPrefs({ scale: value });
                  }}
                >
                  {[m.scaleSmall, m.scaleNormal, m.scaleBig][index]}
                </button>
              ))}
            </span>
          </span>
        </div>

        <div className="k3-row">
          <span className="k3-text">
            <strong>{m.powerTitle}</strong>
            {/* 支持就写「每游戏可覆盖」，不支持就写后端给的那句话 —— 两种都是真话。 */}
            <small>{tdp?.supported ? m.powerHint : tdp?.message || m.powerUnavailable}</small>
          </span>
          <span className="k3-control">
            <button
              type="button"
              className="k3-seg-item"
              data-focusable
              aria-label={`${m.powerTitle} −`}
              disabled={tdpBusy || !tdp?.supported}
              onClick={() => void stepTdp(-1)}
            >
              −
            </button>
            <span className="k3-value tnum">{tdp?.supported ? wattsText : "—"}</span>
            <button
              type="button"
              className="k3-seg-item"
              data-focusable
              aria-label={`${m.powerTitle} ＋`}
              disabled={tdpBusy || !tdp?.supported}
              onClick={() => void stepTdp(1)}
            >
              ＋
            </button>
          </span>
        </div>

        <div className="k3-row">
          <span className="k3-text">
            <strong>{m.deadzoneTitle}</strong>
            <small>
              {m.deadzoneHint} · {m.deadzoneRaw(String(prefsNow.deadzone))}
            </small>
          </span>
          <span className="k3-control">
            <button
              type="button"
              className="k3-seg-item"
              data-focusable
              aria-label={`${m.deadzoneTitle} −`}
              disabled={prefsNow.deadzone <= DEADZONE_CHOICES[0]}
              onClick={() => stepDeadzone(-1)}
            >
              −
            </button>
            <span className="k3-value tnum">
              {m.deadzoneValue(String(Math.round(prefsNow.deadzone * 100)))}
            </span>
            <button
              type="button"
              className="k3-seg-item"
              data-focusable
              aria-label={`${m.deadzoneTitle} ＋`}
              disabled={prefsNow.deadzone >= DEADZONE_CHOICES[DEADZONE_CHOICES.length - 1]}
              onClick={() => stepDeadzone(1)}
            >
              ＋
            </button>
          </span>
        </div>

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
