import { useEffect, useRef } from "react";

type Props = { onBack: () => void };

export function FilesPage({ onBack }: Props) {
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
        <h1>文件管理</h1>
      </header>
      <div className="placeholder-panel">
        <h2>核心差异化功能</h2>
        <p>将提供盘符浏览、复制/粘贴/删除/新建，并完整适配手柄焦点导航。</p>
      </div>
    </main>
  );
}
