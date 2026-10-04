import type { ReactNode } from "react";
import type { TabId } from "../types";

/**
 * 侧栏 / 顶栏用的线性图标。
 *
 * 为什么自己画：项目没装图标库（package.json 里只有 tauri + react），为了 8 个 18dp 图标
 * 引一个依赖不划算；设计稿的图标也是 1.6~2dp 描边的线性风格，纯 path 就够。
 * 颜色一律 currentColor —— 锁定态（ink-4）与选中态（ink）由外层文字色决定，不用传色值。
 */
const base = {
  className: "icon",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: "false" as const,
};

const paths: Record<TabId, ReactNode> = {
  home: (
    <>
      <path d="M3.2 10.4 12 3.3l8.8 7.1" />
      <path d="M5.6 9.7V20h12.8V9.7" />
    </>
  ),
  games: (
    <>
      <rect x="3.2" y="3.2" width="7.4" height="7.4" rx="2" />
      <rect x="13.4" y="3.2" width="7.4" height="7.4" rx="2" />
      <rect x="3.2" y="13.4" width="7.4" height="7.4" rx="2" />
      <rect x="13.4" y="13.4" width="7.4" height="7.4" rx="2" />
    </>
  ),
  apps: (
    <>
      <rect x="3.2" y="4.2" width="17.6" height="15.6" rx="3" />
      <path d="M3.2 10h17.6" />
      <path d="M12 10v9.8" />
    </>
  ),
  downloads: (
    <>
      <path d="M12 3.4v11.2" />
      <path d="m7.4 10.6 4.6 4.6 4.6-4.6" />
      <path d="M4.4 19.6h15.2" />
    </>
  ),
  files: (
    <path d="M3.2 7.4A2.6 2.6 0 0 1 5.8 4.8h3.3l2 2.6h7.1a2.6 2.6 0 0 1 2.6 2.6v7.2a2.6 2.6 0 0 1-2.6 2.6H5.8a2.6 2.6 0 0 1-2.6-2.6z" />
  ),
  // 工具箱：照着画板上的"太阳/螺丝刀"样子画 —— 圆 + 八根短射线。
  toolbox: (
    <>
      <circle cx="12" cy="12" r="3.9" />
      <path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3" />
      <path d="m5.6 5.6 2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  store: (
    <>
      <circle cx="9.4" cy="19.6" r="1.4" />
      <circle cx="17.8" cy="19.6" r="1.4" />
      <path d="M2.8 3.8h2.3l2.5 11.4h10.7l2.1-7.7H5.6" />
    </>
  ),
  community: (
    <path d="M4.2 6.6A2.6 2.6 0 0 1 6.8 4h10.4a2.6 2.6 0 0 1 2.6 2.6v6.8a2.6 2.6 0 0 1-2.6 2.6H10l-4.6 3.6V16h-1.2z" />
  ),
};

export function NavIcon({ id }: { id: TabId }) {
  return <svg {...base}>{paths[id]}</svg>;
}

export function LockIcon() {
  return (
    <svg {...base}>
      <rect x="5" y="10.4" width="14" height="9.8" rx="2.6" />
      <path d="M8.4 10.4V7.9a3.6 3.6 0 0 1 7.2 0v2.5" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg {...base}>
      <circle cx="11" cy="11" r="6.4" />
      <path d="m15.8 15.8 4.4 4.4" />
    </svg>
  );
}

export function GamepadIcon() {
  return (
    <svg {...base}>
      <path d="M8.6 8.4h6.8a4.4 4.4 0 0 1 4.2 5.7l-.9 2.8a2 2 0 0 1-3.4.8l-1.6-1.9H10.3l-1.6 1.9a2 2 0 0 1-3.4-.8l-.9-2.8a4.4 4.4 0 0 1 4.2-5.7z" />
      <path d="M8.1 12.6h2.4M9.3 11.4v2.4" />
      <path d="M15.1 12.4h.01M16.8 13.3h.01" />
    </svg>
  );
}

export function BatteryIcon({ level }: { level: number }) {
  const safe = Math.max(0, Math.min(1, level));
  return (
    <svg {...base}>
      <rect x="2.6" y="7.6" width="16.8" height="8.8" rx="2.6" />
      <path d="M21.4 10.8v2.4" />
      <rect x="4.8" y="9.8" width={Math.max(1.4, 12.4 * safe)} height="4.4" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
