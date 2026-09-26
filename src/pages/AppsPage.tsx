import { useEffect, useRef } from "react";

type Props = { onBack: () => void };

export function AppsPage({ onBack }: Props) {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);

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
        <h1>软件库</h1>
      </header>
      <div className="placeholder-panel">
        <h2>下一里程碑</h2>
        <p>将读取 Windows 卸载注册表与常见安装目录，列出可启动应用。</p>
      </div>
    </main>
  );
}
