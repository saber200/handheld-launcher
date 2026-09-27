import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Props = { active: boolean };

export function SettingsPage({ active }: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    const tauri = inTauri();
    setIsTauri(tauri);
    if (!tauri) return;
    void invoke<boolean>("autostart_enabled")
      .then(setAutostart)
      .catch(() => setMessage("无法读取开机自启状态（需在打包后的桌面端测试）"));
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

  const enterFullscreen = async () => {
    if (!isTauri) {
      setMessage("浏览器预览无法回到全屏");
      return;
    }
    try {
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
      await win.setFullscreen(true);
      setMessage("已回到全屏。");
    } catch (e) {
      setMessage(`无法回到全屏：${String(e)}`);
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
            <small>登录后打开启动器，不替换 Windows 桌面和 Xbox 键</small>
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
          onClick={() => void enterFullscreen()}
        >
          <span>
            <strong>回到全屏</strong>
            <small>把启动器重新铺满屏幕</small>
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

      <p className="about-line">Handheld Launcher v0.1.11</p>
    </div>
  );
}
