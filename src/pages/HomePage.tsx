import { useEffect, useRef } from "react";
import type { PageId } from "../types";

const ITEMS: {
  id: Exclude<PageId, "home">;
  title: string;
  subtitle: string;
  badge: string;
}[] = [
  {
    id: "games",
    title: "游戏库",
    subtitle: "扫描 Steam 等本地游戏并启动",
    badge: "即将开放",
  },
  {
    id: "apps",
    title: "软件库",
    subtitle: "浏览已安装应用",
    badge: "即将开放",
  },
  {
    id: "files",
    title: "文件管理",
    subtitle: "手柄操作的文件浏览器",
    badge: "即将开放",
  },
  {
    id: "settings",
    title: "设置",
    subtitle: "开机自启、全屏与关于",
    badge: "可用",
  },
];

type Props = {
  onNavigate: (page: PageId) => void;
};

export function HomePage({ onNavigate }: Props) {
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  return (
    <main className="page home-page">
      <header className="home-brand">
        <p className="brand-mark">HANDHELD LAUNCHER</p>
        <h1 className="brand-title">掌机启动器</h1>
        <p className="brand-desc">
          全屏壳已就绪。用方向键或手柄选择模块，A 确认，B 返回。
        </p>
      </header>

      <section className="tile-grid" aria-label="主功能">
        {ITEMS.map((item, i) => (
          <button
            key={item.id}
            ref={i === 0 ? firstRef : undefined}
            type="button"
            className="tile"
            data-focusable
            onClick={() => onNavigate(item.id)}
          >
            <span className="tile-badge">{item.badge}</span>
            <span className="tile-title">{item.title}</span>
            <span className="tile-sub">{item.subtitle}</span>
          </button>
        ))}
      </section>

      <footer className="hint-bar">
        <span>↑↓←→ 移动</span>
        <span>A / Enter 确认</span>
        <span>B / Esc 返回</span>
      </footer>
    </main>
  );
}
