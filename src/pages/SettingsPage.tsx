import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Props = { active: boolean };

export function SettingsPage({ active }: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [fse, setFse] = useState("登记后，可在 Windows 的全屏体验里被选成主应用。");
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    const tauri = inTauri();
    setIsTauri(tauri);
    if (!tauri) return;
    void invoke<boolean>("autostart_enabled")
      .then(setAutostart)
      .catch(() => setMessage("无法读取开机自启状态（需在打包后的桌面端测试）"));
    void invoke<string>("fse_status").then(setFse).catch(() => {});
  }, []);

  useEffect(() => {
    if (active) firstRef.current?.focus();
  }, [active]);

  const toggleAutostart = async () => {
    if (!isTauri) {
      setMessage("浏览器预览模式不支持自启，请用 tauri:dev 或安装包验证");
      return;
    }
    setBusy(true);
    try {
      await invoke("set_autostart", { enabled: !autostart });
      const on = await invoke<boolean>("autostart_enabled");
      setAutostart(on);
      setMessage(
        on
          ? "已开启。下次登录进入启动器；这次被关掉也会再打开。"
          : "已关闭。下次登录回到 Windows 桌面。",
      );
    } catch (e) {
      setMessage(`自启设置失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const registerFse = async () => {
    if (!isTauri) {
      setMessage("浏览器预览无法登记全屏体验");
      return;
    }
    setBusy(true);
    try {
      const text = await invoke<string>("register_fse");
      setFse(text);
      setMessage(text);
    } catch (e) {
      const text = `全屏体验登记失败：${String(e)}`;
      setFse(text);
      setMessage(text);
    } finally {
      setBusy(false);
    }
  };

  const openDesktop = async () => {
    if (!isTauri) {
      setMessage("浏览器预览无法打开 Windows 桌面");
      return;
    }
    try {
      await invoke("open_desktop");
      setMessage("已打开 Windows 桌面，启动器还在。");
    } catch (e) {
      setMessage(`无法打开桌面：${String(e)}`);
    }
  };

  const quitApp = async () => {
    if (!isTauri) {
      window.close();
      return;
    }
    await invoke("quit_launcher");
  };

  return (
    <div className="settings-body">
      <section className="settings-list">
        <button
          ref={firstRef}
          type="button"
          className="setting-row"
          data-focusable
          disabled={busy}
          onClick={() => void toggleAutostart()}
        >
          <span>
            <strong>开机自启</strong>
            <small>登录后由启动器当桌面。被关掉会再打开</small>
          </span>
          <span className={`switch ${autostart ? "on" : ""}`}>
            {autostart ? "开" : "关"}
          </span>
        </button>

        <button
          type="button"
          className="setting-row"
          data-focusable
          disabled={busy}
          onClick={() => void registerFse()}
        >
          <span>
            <strong>全屏体验</strong>
            <small>{fse}</small>
          </span>
          <span className="chev">▣</span>
        </button>

        <button type="button" className="setting-row" data-focusable onClick={() => void openDesktop()}>
          <span>
            <strong>打开桌面</strong>
            <small>启动器留着，同时打开 Windows 桌面</small>
          </span>
          <span className="chev">⌂</span>
        </button>

        <button
          type="button"
          className="setting-row danger"
          data-focusable
          onClick={() => void quitApp()}
        >
          <span>
            <strong>退出启动器</strong>
            <small>回到桌面，这次不再自动打开</small>
          </span>
          <span className="chev">⏻</span>
        </button>
      </section>

      {message && <p className="status-msg">{message}</p>}

      <p className="about-line">Handheld Launcher v0.1.7</p>
    </div>
  );
}
