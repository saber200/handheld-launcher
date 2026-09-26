export type AppEntry = {
  id: string;
  name: string;
  mark: string;
  color: string;
  installPath?: string;
  launchPath?: string;
};

/** Browser preview only. Reading installed Windows apps needs the packaged app. */
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
