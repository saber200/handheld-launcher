export type TabId = "games" | "apps" | "files";

export const TABS: { id: TabId; label: string }[] = [
  { id: "games", label: "游戏库" },
  { id: "apps", label: "软件库" },
  { id: "files", label: "文件管理" },
];
