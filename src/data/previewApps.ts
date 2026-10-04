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
  // 浏览器预览的样例数据：带上真字段（版本 / 体积），否则本机没法核对 K2 卡片最底下那一行。
  // 「Xbox」故意只给版本不给体积 —— 用来验证「缺的那半边自己消失」这条降级路径
  // （真实数据里 EstimatedSize 缺省很常见）。
  { id: "steam", name: "Steam", mark: "S", color: "#1b2838", version: "1738021142", sizeBytes: 2576980377 },
  { id: "edge", name: "Microsoft Edge", mark: "E", color: "#0f766e", version: "131.0.2903.86", sizeBytes: 2040109466 },
  { id: "chrome", name: "Google Chrome", mark: "C", color: "#1d4e89", version: "131.0.6778.86", sizeBytes: 1503238554 },
  { id: "discord", name: "Discord", mark: "D", color: "#3c3489", version: "1.0.9174", sizeBytes: 429916160 },
  { id: "spotify", name: "Spotify", mark: "Sp", color: "#146c43", version: "1.2.52.442", sizeBytes: 335544320 },
  { id: "epic", name: "Epic Games", mark: "Ep", color: "#2a2a2a", version: "17.3.1", sizeBytes: 1181116006 },
  { id: "xbox", name: "Xbox", mark: "X", color: "#107c10", version: "2411.1001.5.0" },
  { id: "explorer", name: "文件资源管理器", mark: "文", color: "#1e3a5f", version: "10.0.26100.2314", sizeBytes: 125829120 },
  { id: "wechat", name: "微信", mark: "微", color: "#1a7f37", version: "3.9.12", sizeBytes: 1000341504 },
  { id: "qqmusic", name: "QQ 音乐", mark: "音", color: "#8a5a00", version: "19.51", sizeBytes: 377487360 },
  { id: "obs", name: "OBS Studio", mark: "O", color: "#1f2937", version: "31.0.0", sizeBytes: 545259520 },
  { id: "vscode", name: "Visual Studio Code", mark: "Vs", color: "#243056", version: "1.95.3", sizeBytes: 1395864371 },
];
