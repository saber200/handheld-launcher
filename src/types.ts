/**
 * 一级分区。改造后是左侧竖排侧栏 8 项（顺序与 docs/redesign 的侧栏一致）：
 * 首页 / 游戏库 / 软件库 / 下载 / 文件 / 工具箱 / 商店 / 社区。
 *
 * 商店与社区本版不实现，但**入口要留**（表达产品路线）：它们是 locked，
 * 既不能进 [data-focusable]、也不能被 LB/RB 循环选中 —— 见 NAV_ROUTES。
 */
export type TabId =
  | "home"
  | "games"
  | "apps"
  | "downloads"
  | "files"
  | "toolbox"
  // 模拟器页：六个平台一张卡一个，装到非系统盘（见 pages/EmulatorsPage.tsx）。
  | "emulators"
  | "store"
  | "community";

export type NavItem = { id: TabId; locked?: boolean };

export const NAV: NavItem[] = [
  { id: "home" },
  { id: "games" },
  { id: "apps" },
  { id: "downloads" },
  { id: "files" },
  { id: "toolbox" },
  { id: "emulators" },
  { id: "store", locked: true },
  { id: "community", locked: true },
];

/** 可进入的分区（LB / RB 与 Q / E 只在这些人里循环）。 */
export const NAV_ROUTES: TabId[] = NAV.filter((item) => !item.locked).map((item) => item.id);

export function isLocked(id: TabId): boolean {
  return NAV.some((item) => item.id === id && item.locked);
}

