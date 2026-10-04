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
 * 为什么只按扩展名、不读文件头魔数：读魔数要一个新的 Rust 原语（改造包 §1 只允许加
 * `file_thumb`）。代价写在这儿，免得以后被当成 bug：`.iso` 可能是 PS2、PS1、Wii 甚至 PSP
 * 的镜像，这里一律归 PS2 —— 但向导第 2 步可以把这个分组的目标改掉，这正是向导的意义。
 */
export const ROM_PLATFORMS: RomPlatform[] = [
  {
    key: "switch",
    label: "Nintendo Switch",
    folder: "switch",
    emulator: "Ryujinx",
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
