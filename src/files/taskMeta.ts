/*
 * ROM 平台的判定表。
 *
 * 为什么单独一个文件：有两个地方要用同一张表 —— 「导入 ROM」任务用它分组，
 * 预览面板用它显示「这是什么平台的 ROM」。两处各写一份，迟早会出现
 * 「导入时认它是 PSP、预览里说它是 PS2」这种自相矛盾。
 */
export type RomPlatform = {
  key: string;
  label: string;
  /** ROM 根下的子目录名。 */
  folder: string;
  emulator: string;
  exts: string[];
  color: "accent" | "accent-2" | "violet" | "warning";
};

/**
 * 判定表。
 *
 * 为什么只按扩展名：绝大多数平台（.nsp / .cso / .3ds / .gba…）扩展名就是唯一的判据。
 * **例外是光碟镜像**（`.iso` / `.bin` / `.img`）：它们底下可能是 PS2、PSP、PS1 甚至 Wii，
 * 所以「导入 ROM」会去读文件头（Rust 侧 `winfs.rs::probe_disc`）再定组，
 * 读不出魔数的落到「没认出来」那一组、由用户自己指定目标（0.1.61，功能 15 第 4 条）。
 *
 * 这里保留 `.iso → ps2` 这条映射有两个用处：一是预览面板在没有魔数可读时的兜底显示，
 * 二是探测被封顶（文件太多 / 读不动）时的退路。
 */
export const ROM_PLATFORMS: RomPlatform[] = [
  {
    key: "switch",
    label: "Nintendo Switch",
    folder: "switch",
    emulator: "Eden",
    exts: [".nsp", ".xci", ".nca"],
    color: "accent",
  },
  {
    key: "ps2",
    label: "PlayStation 2",
    folder: "ps2",
    emulator: "PCSX2",
    exts: [".iso"],
    color: "accent-2",
  },
  {
    key: "psp",
    label: "PSP",
    folder: "psp",
    emulator: "PPSSPP",
    exts: [".cso", ".chd"],
    color: "violet",
  },
  {
    key: "n3ds",
    label: "Nintendo 3DS",
    folder: "3ds",
    emulator: "Citra",
    exts: [".3ds", ".cia"],
    color: "accent",
  },
  {
    key: "retro",
    label: "Retro",
    folder: "retro",
    emulator: "RetroArch",
    exts: [".gba", ".nds", ".sfc", ".smc", ".md", ".gen"],
    color: "warning",
  },
];

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** 认出来就返回平台名（「Nintendo Switch」），认不出返回 null。 */
export function platformOf(name: string): string | null {
  const ext = extensionOf(name);
  return ROM_PLATFORMS.find((platform) => platform.exts.includes(ext))?.label ?? null;
}
