/*
 * 浏览器预览用的假数据（`npm run dev` 在 macOS 上直接看这一页）。
 *
 * 为什么要它：真数据全在 Rust 侧（Windows 专属：下载、解压、盘符），macOS 上这一页
 * 只能拿到一张空表 —— 那就等于这一页的排版（六张卡、进度条、按钮换行）在本机永远没人看过，
 * 只能等真机。这跟 `previewGames.ts` / `previewApps.ts` 是同一个用途。
 *
 * **只用于预览**：`EmulatorsPage` 在 `__TAURI_INTERNALS__` 不存在时才读它，打进真机包也不影响
 * （真机走 `emulator_list`，这个常量根本不会被读）。
 *
 * 六张卡故意不重样，一屏就能看出四种状态：
 *   PCSX2 装好且有版本、MAME 装好但没量过体积、RetroArch 没装、RPCS3 / Switch 只能手装。
 * 磁盘占用也故意大小差得远（79 MB ↔ 1.2 GB），用来核对体积那一格的排版。
 */
import type { EmulatorStatus } from "../pages/EmulatorsPage";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export const PREVIEW_EMULATOR_ROOT = "D:\\Emulation\\Apps";

export const PREVIEW_EMULATORS: EmulatorStatus[] = [
  {
    id: "ps2",
    name: "PlayStation 2",
    badge: "PS2",
    emulator: "PCSX2",
    vendor: "PCSX2 Team",
    desc: "PS2 上兼容性最好的模拟器，官方 Windows 版。",
    note: "",
    manualReason: "",
    manualUrl: "",
    installed: true,
    version: "2.8.2",
    dir: "D:\\Emulation\\Apps\\PCSX2",
    romDir: "ps2",
    exe: "D:\\Emulation\\Apps\\PCSX2\\pcsx2-qt.exe",
    bytes: Math.round(0.19 * GB),
    supported: true,
  },
  {
    id: "ps3",
    name: "PlayStation 3",
    badge: "PS3",
    emulator: "RPCS3",
    vendor: "RPCS3 Team",
    desc: "PS3 模拟器。从不发稳定版，装到的是官方最新的滚动构建。",
    note: "",
    manualReason: "",
    manualUrl: "",
    installed: false,
    version: "",
    dir: "D:\\Emulation\\Apps\\RPCS3",
    romDir: "ps3",
    exe: "D:\\Emulation\\Apps\\RPCS3\\rpcs3.exe",
    bytes: 0,
    supported: true,
  },
  {
    id: "switch",
    name: "Nintendo Switch",
    badge: "NS",
    emulator: "Eden",
    vendor: "Eden Project",
    desc: "Switch 模拟器（原 Ryujinx 下架后换成 Eden）。",
    note: "只玩你自己拥有的游戏。本程序不附带任何游戏本体。",
    manualReason: "",
    manualUrl: "",
    installed: false,
    version: "",
    dir: "D:\\Emulation\\Apps\\Eden",
    romDir: "switch",
    exe: "D:\\Emulation\\Apps\\Eden\\eden.exe",
    bytes: 0,
    supported: true,
  },
  {
    id: "ps4",
    name: "PlayStation 4",
    badge: "PS4",
    emulator: "shadPS4",
    vendor: "shadPS4 Team",
    desc: "PS4 模拟器，还在早期，能跑通的商业游戏不多。",
    note: "",
    manualReason: "",
    manualUrl: "",
    installed: false,
    version: "",
    dir: "D:\\Emulation\\Apps\\shadPS4",
    romDir: "ps4",
    exe: "D:\\Emulation\\Apps\\shadPS4\\shadPS4.exe",
    bytes: 0,
    supported: true,
  },
  {
    id: "arcade",
    name: "街机",
    badge: "ARC",
    emulator: "MAME",
    vendor: "MAME Team",
    desc: "街机模拟器，官方 Windows 自解压包。",
    note: "",
    manualReason: "",
    manualUrl: "",
    installed: true,
    version: "0.289",
    dir: "D:\\Emulation\\Apps\\MAME",
    romDir: "arcade",
    exe: "D:\\Emulation\\Apps\\MAME\\mame.exe",
    // 故意是 0：核对「装好了但还没量过体积」那格写的是「体积待量」而不是 0 B。
    bytes: 0,
    supported: true,
  },
  {
    id: "retro",
    name: "全能模拟器",
    badge: "ALL",
    emulator: "RetroArch",
    vendor: "Libretro",
    desc: "一个前端带一堆核心，NES 到 PSP 都能跑。核心另外下。",
    note: "",
    manualReason: "",
    manualUrl: "",
    installed: true,
    version: "1.22.2",
    dir: "D:\\Emulation\\Apps\\RetroArch",
    romDir: "retro",
    exe: "D:\\Emulation\\Apps\\RetroArch\\retroarch.exe",
    bytes: Math.round(1.2 * GB),
    supported: true,
  },
];

/** 预览里也画一个像样的体积数（`bytes` 是 0 的那张卡要显示「体积待量」）。 */
export const PREVIEW_EMULATOR_SIZES: [string, number][] = [
  ["ps2", Math.round(0.19 * GB)],
  ["arcade", Math.round(79 * MB)],
  ["retro", Math.round(1.2 * GB)],
];
