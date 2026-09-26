export type GameEntry = {
  id: string;
  name: string;
  cover: string;
  installPath?: string;
  launchPath?: string;
  /** Set when launch should open this path instead of Steam or Epic. */
  customPath?: boolean;
};

/** Browser preview only. Real library scanning needs the Windows app. */
export const PREVIEW_GAMES: GameEntry[] = [
  { id: "2358720", name: "黑神话：悟空", cover: cover(2358720) },
  { id: "1245620", name: "艾尔登法环", cover: cover(1245620) },
  { id: "1091500", name: "赛博朋克 2077", cover: cover(1091500) },
  { id: "1086940", name: "博德之门 3", cover: cover(1086940) },
  { id: "292030", name: "巫师 3：狂猎", cover: cover(292030) },
  { id: "1145360", name: "哈迪斯", cover: cover(1145360) },
  { id: "814380", name: "只狼：影逝二度", cover: cover(814380) },
  { id: "1426210", name: "双人成行", cover: cover(1426210) },
  { id: "413150", name: "星露谷物语", cover: cover(413150) },
  { id: "367520", name: "空洞骑士", cover: cover(367520) },
  { id: "1551360", name: "极限竞速：地平线 5", cover: cover(1551360) },
  { id: "289070", name: "文明 VI", cover: cover(289070) },
];

function cover(appId: number): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
}
