import { useEffect, useRef } from "react";

type Props = { onBack: () => void };

export function GamesPage({ onBack }: Props) {
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
        <h1>游戏库</h1>
      </header>
      <div className="placeholder-panel">
        <h2>下一里程碑</h2>
        <p>将接入 Steam / Epic / GOG 本地库扫描、封面缓存与一键启动。</p>
      </div>
    </main>
  );
}
