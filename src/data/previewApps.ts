export type AppEntry = {
  id: string;
  name: string;
  mark: string;
  color: string;
  icon?: string;
  installPath?: string;
  launchPath?: string;
  /** Set when launch should open this path instead of the scanned command. */
  customPath?: boolean;
  /** 版本（注册表 `DisplayVersion`）。空 = 软件自己没写，界面不画。 */
  version?: string;
  /** 占用空间（字节），注册表 `EstimatedSize`。0 / undefined = 不知道。 */
  sizeBytes?: number;
};

export function displayAppMark(id: string, mark: string, locale: string): string {
  if (locale !== "en") return mark;
  if (id === "explorer") return "F";
  if (id === "wechat") return "W";
  if (id === "qqmusic") return "Q";
  return mark;
}

export function displayAppName(id: string, name: string, locale: string): string {
  if (locale !== "en") return name;
  if (id === "explorer" && name === "文件资源管理器") return "File Explorer";
  if (id === "wechat" && name === "微信") return "WeChat";
  if (id === "qqmusic" && name === "QQ 音乐") return "QQ Music";
  return name;
}
export const PREVIEW_APPS: AppEntry[] = [
  { id: "steam", name: "Steam", mark: "S", color: "#1b2838" },
  { id: "edge", name: "Microsoft Edge", mark: "E", color: "#0f766e" },
  { id: "chrome", name: "Google Chrome", mark: "C", color: "#1d4e89" },
  { id: "discord", name: "Discord", mark: "D", color: "#3c3489" },
  { id: "spotify", name: "Spotify", mark: "Sp", color: "#146c43" },
  { id: "epic", name: "Epic Games", mark: "Ep", color: "#2a2a2a" },
  { id: "xbox", name: "Xbox", mark: "X", color: "#107c10" },
  { id: "explorer", name: "文件资源管理器", mark: "文", color: "#1e3a5f" },
  { id: "wechat", name: "微信", mark: "微", color: "#1a7f37" },
  { id: "qqmusic", name: "QQ 音乐", mark: "音", color: "#8a5a00" },
  { id: "obs", name: "OBS Studio", mark: "O", color: "#1f2937" },
  { id: "vscode", name: "Visual Studio Code", mark: "Vs", color: "#243056" },
];
