import { useEffect, useRef, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Props = { onBack: () => void };

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function SettingsPage({ onBack }: Props) {
  const backRef = useRef<HTMLButtonElement>(null);
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    backRef.current?.focus();
    const tauri = inTauri();
    setIsTauri(tauri);
    if (!tauri) return;
    void isEnabled()
      .then(setAutostart)
      .catch(() => setMessage("无法读取开机自启状态（需在打包后的桌面端测试）"));
  }, []);

  const toggleAutostart = async () => {
    if (!isTauri) {
      setMessage("浏览器预览模式不支持自启，请用 tauri:dev 或安装包验证");
      return;
    }
    setBusy(true);
    try {
      if (autostart) {
        await disable();
        setAutostart(false);
        setMessage("已关闭开机自启");
      } else {
        await enable();
        setAutostart(true);
        setMessage("已开启开机自启");
      }
    } catch (e) {
      setMessage(`自启设置失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleFullscreen = async () => {
    if (!isTauri) {
      setMessage("浏览器预览无法切换系统全屏");
      return;
    }
    try {
      const win = getCurrentWindow();
      const fs = await win.isFullscreen();
      await win.setFullscreen(!fs);
      setMessage(fs ? "已退出全屏" : "已进入全屏");
    } catch (e) {
      setMessage(`全屏切换失败：${String(e)}`);
    }
  };

  const quitApp = async () => {
    if (!isTauri) {
      window.close();
      return;
    }
    await getCurrentWindow().close();
  };

  return (
    <main className="page stack-page">
      <header className="page-header">
        <button
          ref={backRef}
          type="button"
          className="ghost-btn"
          data-focusable
          onClick={onBack}
        >
          ← 返回
        </button>
        <h1>设置</h1>
      </header>

      <section className="settings-list">
        <button
          type="button"
          className="setting-row"
          data-focusable
          disabled={busy}
          onClick={() => void toggleAutostart()}
        >
          <span>
            <strong>开机自启</strong>
            <small>登录 Windows 后自动打开启动器</small>
          </span>
          <span className={`switch ${autostart ? "on" : ""}`}>
            {autostart ? "开" : "关"}
          </span>
        </button>

        <button
          type="button"
          className="setting-row"
          data-focusable
          onClick={() => void toggleFullscreen()}
        >
          <span>
            <strong>切换全屏</strong>
            <small>掌机建议保持全屏沉浸</small>
          </span>
          <span className="chev">⛶</span>
        </button>

        <button
          type="button"
          className="setting-row danger"
          data-focusable
          onClick={() => void quitApp()}
        >
          <span>
            <strong>退出启动器</strong>
            <small>返回桌面</small>
          </span>
          <span className="chev">⏻</span>
        </button>
      </section>

      {message && <p className="status-msg">{message}</p>}

      <p className="about-line">Handheld Launcher v0.1.0 · 里程碑 1：全屏壳</p>
    </main>
  );
}
