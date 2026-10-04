export type GameEntry = {
  id: string;
  name: string;
  cover: string;
  /** HTTPS fallback when a local asset:// cover fails to load. */
  coverRemote?: string;
  installPath?: string;
  launchPath?: string;
  /** Set when launch should open this path instead of Steam or Epic. */
  customPath?: boolean;
  /**
   * 占用空间（字节）。**0 / undefined = 不知道**，界面不画这一格（不许当 0 显示）。
   * 来自 Rust 扫描：Steam 是 `appmanifest` 的 SizeOnDisk、Epic 是 manifest 的 InstallSize。
   */
  sizeBytes?: number;
  /** 总时长（分钟）。0 / undefined = 不知道。目前只有 Steam 有（localconfig 的 Playtime）。 */
  playtimeMinutes?: number;
};

/** Browser preview only. Real library scanning needs the Windows app. */
export const PREVIEW_GAMES: GameEntry[] = [
  { id: "2358720", name: "黑神话：悟空", cover: cover(2358720), sizeBytes: gb(130), playtimeMinutes: hours(32.5) },
  { id: "1245620", name: "艾尔登法环", cover: cover(1245620), sizeBytes: gb(60), playtimeMinutes: hours(88.2) },
  { id: "1091500", name: "赛博朋克 2077", cover: cover(1091500), sizeBytes: gb(70), playtimeMinutes: hours(45.1) },
  { id: "1086940", name: "博德之门 3", cover: cover(1086940), sizeBytes: gb(122), playtimeMinutes: hours(96.4) },
  { id: "292030", name: "巫师 3：狂猎", cover: cover(292030), sizeBytes: gb(50), playtimeMinutes: hours(120) },
  { id: "1145360", name: "哈迪斯", cover: cover(1145360), sizeBytes: gb(15), playtimeMinutes: hours(42.6) },
  // 只狼故意不给时长：用来核对「拿不到的那一格不画」这条（不能显示 0 分钟）
  { id: "814380", name: "只狼：影逝二度", cover: cover(814380), sizeBytes: gb(14) },
  { id: "1426210", name: "双人成行", cover: cover(1426210), sizeBytes: gb(45), playtimeMinutes: hours(12.8) },
  { id: "413150", name: "星露谷物语", cover: cover(413150), sizeBytes: gb(1), playtimeMinutes: hours(64.3) },
  { id: "367520", name: "空洞骑士", cover: cover(367520), sizeBytes: gb(8.4), playtimeMinutes: hours(42.6) },
  { id: "1551360", name: "极限竞速：地平线 5", cover: cover(1551360), sizeBytes: gb(110), playtimeMinutes: hours(26.7) },
  { id: "289070", name: "文明 VI", cover: cover(289070), sizeBytes: gb(26), playtimeMinutes: hours(210.5) },
];

function gb(value: number): number {
  return Math.round(value * 1024 ** 3);
}

function hours(value: number): number {
  return Math.round(value * 60);
}

function cover(appId: number): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
}

const EN_TITLES: Record<string, string> = {
  "2358720": "Black Myth: Wukong",
  "1245620": "ELDEN RING",
  "1091500": "Cyberpunk 2077",
  "1086940": "Baldur's Gate 3",
  "292030": "The Witcher 3: Wild Hunt",
  "1145360": "Hades",
  "814380": "Sekiro",
  "1426210": "It Takes Two",
  "413150": "Stardew Valley",
  "367520": "Hollow Knight",
  "1551360": "Forza Horizon 5",
  "289070": "Civilization VI",
};

export function displayGameName(id: string, name: string, locale: string): string {
  if (locale === "en" && EN_TITLES[id] && PREVIEW_GAMES.some((game) => game.id === id && game.name === name)) {
    return EN_TITLES[id];
  }
  return name;
}
