import {
  IconApps,
  IconArrowUp,
  IconBattery,
  IconBattery1,
  IconBattery2,
  IconBattery3,
  IconBattery4,
  IconDeviceGamepad2,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconHome2,
  IconKeyboard,
  IconLayoutGrid,
  IconLock,
  IconMenu2,
  IconMessageCircle,
  IconPlayerPlayFilled,
  IconRefresh,
  IconSearch,
  IconShoppingCart,
  IconSortDescending,
  IconTools,
} from "@tabler/icons-react";
import type { TabId } from "../types";

/**
 * 侧栏 / 顶栏 / 各页共用的线性图标。
 *
 * **为什么换成 Tabler**（原先这里是二十来个手绘 path）：
 * 手绘只划算在「8 个 18dp 图标」那个阶段。这个启动器后来要的是**游戏平台品牌 +
 * 掌机硬件**图标（Steam / Epic / Xbox、风扇、电量、SD 卡…），手绘成本已经远高于
 * 引一个依赖：`@tabler/icons-react` 每个图标是独立模块，Vite 按需 tree-shake，
 * 最终只打包这里 import 的那几个，体积与手绘 SVG 基本一致。
 * 选 Tabler 而不是 Lucide / Phosphor 的决定性原因是**只有它带品牌图标**
 * （`brand-steam` / `brand-xbox` / `brand-windows` 与 PS 的 ○✕△□ 按键）——
 * Lucide 明确不收品牌图标，而本项目的游戏来源扫描、Xbox 模式、手柄提示都要用。
 *
 * 风格：Tabler outline 与原来的手绘规格逐项对得上 —— 24×24 viewBox、
 * `fill:none`、`stroke:currentColor`、圆头圆角。唯一差别是它默认描边 2，
 * 这里统一压到 1.7（画板规格 1.6~1.7），见下面的 `stroke`。
 * 颜色仍然一律 currentColor：锁定态（ink-4）与选中态（ink）由外层文字色决定。
 */
const stroke = 1.7;

/** 线性图标的公共属性。`className="icon"` 让 CSS 里的 18dp 尺寸接管（覆盖 svg 自带的 24 属性）。 */
const line = {
  className: "icon",
  stroke,
  "aria-hidden": true,
  focusable: "false" as const,
};

/** 实心图标（播放键）不吃描边，走单独的属性。 */
const solid = {
  className: "icon",
  "aria-hidden": true,
  focusable: "false" as const,
};

const tabs: Record<TabId, typeof IconHome2> = {
  home: IconHome2,
  games: IconLayoutGrid,
  apps: IconApps,
  downloads: IconDownload,
  files: IconFolder,
  toolbox: IconTools,
  store: IconShoppingCart,
  community: IconMessageCircle,
};

export function NavIcon({ id }: { id: TabId }) {
  const Glyph = tabs[id];
  return <Glyph {...line} />;
}

export function LockIcon() {
  return <IconLock {...line} />;
}

export function SearchIcon() {
  return <IconSearch {...line} />;
}

export function GamepadIcon() {
  return <IconDeviceGamepad2 {...line} />;
}

/** K1 操作区：开始游戏。 */
export function PlayIcon() {
  return <IconPlayerPlayFilled {...solid} />;
}

/** 卡片菜单（三横）。 */
export function MenuIcon() {
  return <IconMenu2 {...line} />;
}

/** 重新扫描。 */
export function RefreshIcon() {
  return <IconRefresh {...line} />;
}

export function FolderIcon() {
  return <IconFolder {...line} />;
}

/**
 * 侧栏存储卡那颗「打开管理器」用的**打开态**文件夹。
 * 这里以前画的是手柄 —— 画板上那颗按钮本来是「手柄图标 + A + 打开管理器」的**按键提示**，
 * 代码把 A 丢了、只剩手柄，结果一个「打开文件管理器」的按钮顶着游戏手柄，语义对不上，
 * 在 18dp 下还容易被看成两个字母。换 `folder-open` 后图标直接说清按下去会发生什么。
 */
export function FolderOpenIcon() {
  return <IconFolderOpen {...line} />;
}

export function FileIcon() {
  return <IconFile {...line} />;
}

/** 排序（三条递减的横线）。 */
export function SortIcon() {
  return <IconSortDescending {...line} />;
}

/** 键盘（软键盘入口）。 */
export function KeyboardIcon() {
  return <IconKeyboard {...line} />;
}

/** 返回上一级。 */
export function UpIcon() {
  return <IconArrowUp {...line} />;
}

/** 隐藏文件开关（睁眼 / 闭眼）。 */
export function EyeIcon({ off }: { off?: boolean }) {
  const Glyph = off ? IconEyeOff : IconEye;
  return <Glyph {...line} />;
}

/**
 * 电量。Tabler 把电池做成带格数的一整套（空 + 1~4 格），比原先手绘那根
 * 「按比例伸缩的填充条」更好认：四档在 18dp 上仍然分得清，而缩放条在低电量时
 * 只剩一两个像素、等于没画。阈值取 1/4 档位，四舍五入到最近的一档。
 */
export function BatteryIcon({ level }: { level: number }) {
  const safe = Math.max(0, Math.min(1, level));
  const Glyph =
    safe <= 0.02
      ? IconBattery
      : safe <= 0.375
        ? IconBattery1
        : safe <= 0.625
          ? IconBattery2
          : safe <= 0.875
            ? IconBattery3
            : IconBattery4;
  return <Glyph {...line} />;
}
