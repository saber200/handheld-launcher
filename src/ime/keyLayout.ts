/*
 * 键面布局。**按用户 2026-10-13 拍的 OneXPlayer 屏幕键盘照片逐键对齐**。
 *
 * 纯数据、不含 React —— 因为「这把键盘能打出哪些字符」需要一个跑在 Node 里、
 * 不引 React 的测试盯着（`keyLayout.test.ts`）。改键表改这里，然后 `npm test`。
 *
 * ## 照片读出来的三条关键事实
 *
 * 1. **它是一把完整键盘，不是分层的**：6 行 —— `Esc+F1–F12` / 数字行 / `Tab`+QWERTY /
 *    `Caps`+ASDF / `Shift`+ZXCV / `Ctrl Win Alt`+空格+方向键。Shift 的作用只是把键面
 *    在**同一个键印的上下两个字符**之间切换（第二张图 Shift 点亮后字母变大写、数字变符号），
 *    所以我原来那套「字母层 / 符号层」可以整个去掉。
 * 2. **符号全在数字行的 Shift 形态里**：`` `~ `` `1!` `2@` `3#` `4$` `5%` `6^` `7&` `8*`
 *    `9(` `0)` `-_` `=+`，再配上 `[{` `]}` `\|` `;:` `'"` `,<` `.>` `/?` —— 整套 ASCII 都在。
 * 3. **键面上直接印手柄角标**：`X` 在 Backspace 上、`Y` 在空格上、`R2` 在 Enter 上、
 *    `L2` 在左 Shift 上、`L3` 在 Caps 上。这是这把键盘最好用的部分：用户不用记
 *    「哪个键是退格」，看键面就知道。
 *
 * ## 一个猜错又改回来的地方
 *
 * 我原本把 `L2` 猜成「左扳机按到底」（两段行程），因为标准手柄里 LT 与 L2 是同一个键。
 * 照片显示**左 Shift 那颗键上印着 `L2`** —— 它是**一个独立的物理键**，和 `LT` 不是一回事。
 * 所以 `LT` 与 `L2` 各接各的：**LT = 按住 Shift，L2 = 这颗 Shift 键（按下锁上、再按松开）**。
 */

/**
 * 键面上印的**手柄角标** —— 直接从照片读出来的。
 * 角标是这把键盘的识别特征，也是它比一把普通软键盘好用的地方。
 */
export type GamepadBadge = "X" | "Y" | "L2" | "R2" | "L3";

/** 非字符键的 id。组件与 `App.tsx` 靠它分派行为。 */
export type WideId =
  | "esc" | "backspace" | "tab" | "caps" | "enter"
  | "shift-left" | "shift-right" | "ctrl" | "win" | "alt"
  | "arrow-left" | "arrow-up" | "arrow-down" | "arrow-right";

/**
 * 一颗键。
 *
 * `shiftedOf` 是**同一个键在 Shift 下打出来的另一个字符**（真键盘上印在键面下半部分，
 * 照片里就是 `1` 上面那个 `!`）。字母不需要写它 —— 大写是小写字母的天然 Shift 形态。
 */
export type Key =
  /**
   * 字符键：`label` 是键面主文字。
   *
   * `code` 缺省 = **功能键**（照片里的 `F1`–`F12`）：有键面、能聚焦、按下去有反馈，
   * 但**不往输入框里送文字** —— 否则按 F1 会打出字面的「f1」，那是错的。
   */
  | { kind: "char"; label: string; code?: string; shiftedOf?: string }
  /** 功能键（Shift / Enter / Tab…）：行为由 `id` 决定。 */
  | { kind: "wide"; id: WideId; label: string; badge?: GamepadBadge; units?: number }
  /** 空格：`Y` 角标印在中间。 */
  | { kind: "space"; label: string; badge: GamepadBadge; units?: number };

const char = (code: string, shiftedOf?: string): Key => ({ kind: "char", label: code, code, shiftedOf });
/** 功能键：只有键面，不送文字。 */
const fn = (label: string): Key => ({ kind: "char", label });
const wide = (id: WideId, label: string, badge?: GamepadBadge, units?: number): Key => ({
  kind: "wide",
  id,
  label,
  badge,
  units,
});

/** 第 1 行：`Esc` + `F1`–`F12`。 */
const ROW_FN: Key[] = [
  wide("esc", "Esc", undefined, 1.4),
  ...Array.from({ length: 12 }, (_, i) => fn(`F${i + 1}`)),
]; // 1.4 + 12 = 13.4

/** 第 2 行：`` ` `` + 数字 + `-` `=` + `Backspace`（右上角，印 `X`）。 */
const ROW_NUMBERS: Key[] = [
  char("`", "~"),
  char("1", "!"), char("2", "@"), char("3", "#"), char("4", "$"), char("5", "%"),
  char("6", "^"), char("7", "&"), char("8", "*"), char("9", "("), char("0", ")"),
  char("-", "_"), char("=", "+"),
  wide("backspace", "Backspace", "X", 1.4),
]; // 13 字符 + 1.4 = 14.4 单位

/** 第 3 行：`Tab` + QWERTY + `[` `]` `\`。 */
const ROW_QWERTY: Key[] = [
  wide("tab", "Tab", undefined, 1.4),
  ..."qwertyuiop".split("").map((c) => char(c)),
  char("[", "{"), char("]", "}"), char("\\", "|"),
];

/** 第 4 行：`Caps`（印 `L3`）+ ASDF + `;` `'` + `Enter`（印 `R2`）。 */
const ROW_ASDF: Key[] = [
  wide("caps", "Caps", "L3", 1.4),
  ..."asdfghjkl".split("").map((c) => char(c)),
  char(";", ":"), char("'", "\""),
  wide("enter", "Enter", "R2", 1.4),
]; // 1.6 + 9 字符 + 2 字符 + 1.4 = 14.4

/** 第 5 行：左 `Shift`（印 `L2`，**L2 就是这颗键**）+ ZXCV + `,` `.` `/` + 右 Shift。 */
const ROW_ZXCV: Key[] = [
  wide("shift-left", "Shift", "L2", 1.8),
  ..."zxcvbnm".split("").map((c) => char(c)),
  char(",", "<"), char(".", ">"), char("/", "?"),
  wide("shift-right", "Shift", undefined, 1.8),
]; // 1.8 + 7 字符 + 3 字符 + 1.8 = 13.6

/** 第 6 行：`Ctrl` `Win` `Alt` + 空格（印 `Y`）+ 四个方向键。 */
const ROW_BOTTOM: Key[] = [
  wide("ctrl", "Ctrl", undefined, 1.75),
  wide("win", "Win", undefined, 1.75),
  wide("alt", "Alt", undefined, 1.75),
  { kind: "space", label: "空格", badge: "Y", units: 4.4 },
  wide("arrow-left", "◀", undefined, 0.9),
  wide("arrow-up", "▲", undefined, 0.9),
  wide("arrow-down", "▼", undefined, 0.9),
  wide("arrow-right", "▶", undefined, 0.9),
]; // 3×1.75 + 4.4 + 4×0.9 = 13.25

/** 照片里那一把键盘：6 行。 */
export const KEY_ROWS: Key[][] = [ROW_FN, ROW_NUMBERS, ROW_QWERTY, ROW_ASDF, ROW_ZXCV, ROW_BOTTOM];

/** 行数。测试拿它核对「加中文标点行之前」的行数没被随手改动。 */
export const ROW_COUNT = KEY_ROWS.length;

/** 每行键数上限（照片里最长的一行是 13 颗）。 */
export const MAX_KEYS_PER_ROW = 14;

/**
 * 中文标点行。
 *
 * **照片里没有这一行** —— 这是本仓库自己加的：OneXPlayer 那把键盘是给 Windows 通用
 * 场景用的，而本启动器的输入框里会出现中文文件名、中文搜索词，自带中文标点的键盘
 * 比让用户去数字行凑 `，` 方便得多。放在最后一行，两层共用，不参与 Shift 变换。
 *
 * `——` 是一个键打出两个字符（中文破折号本来就占两格）。
 */
export const CJK_PUNCT = ["，", "。", "？", "！", "、", "：", "；", "…", "——", "·"] as const;

/** 键盘的 Shift 形态。`upper` = Shift 生效（按住 LT / 锁上 L2 / Caps 开着）。 */
export type KeyboardLayer = "lower" | "upper";

/**
 * 打这颗键送进输入框的字符。非字符键（Shift / 空格 / 方向键…）返回 null。
 *
 * 空格单独处理：它在 `upper` 下也只能是空格 —— 不能因为 Shift 生效就打出别的东西。
 */
export function charFor(key: Key, layer: KeyboardLayer): string | null {
  if (key.kind === "space") return " ";
  if (key.kind !== "char") return null;
  // 功能键（F1–F12）：不送文字
  if (!key.code) return null;
  if (layer === "upper") {
    if (key.shiftedOf) return key.shiftedOf;
    if (/^[a-z]$/.test(key.code)) return key.code.toUpperCase();
  }
  return key.code;
}

/**
 * 两层合起来能打出的**全部字符**（测试用它核对整套 ASCII 覆盖）。
 *
 * 中文标点行不在里面 —— 它和 Shift 无关，由 `CJK_PUNCT` 单独核对。
 */
export function reachableCharacters(): Set<string> {
  const out = new Set<string>();
  for (const layer of ["lower", "upper"] as const) {
    for (const row of KEY_ROWS) {
      for (const key of row) {
        const ch = charFor(key, layer);
        if (ch) out.add(ch);
      }
    }
  }
  return out;
}

/** 按坐标取键（测试与探针靠它「第几行第几列」定位，对齐照片时很有用）。 */
export function keyAt(row: number, column: number): Key | undefined {
  return KEY_ROWS[row]?.[column];
}

/** 一行的键数。 */
export function rowWidth(row: number): number {
  return KEY_ROWS[row]?.length ?? 0;
}

/** 一颗键占几个「字符键宽度」（视觉宽度，`flex-grow` 用它）。 */
export function unitsOf(key: Key): number {
  if (key.kind === "space") return key.units ?? 4.4;
  if (key.kind === "wide") return key.units ?? 1.6;
  return 1;
}

/**
 * 一行占多少个宽度单位。
 *
 * 这个值**各行之间必须接近**（差得多了，行与行之间键宽不一致，看起来是「歪的」）。
 * 照片里就是这个规律：`Esc` 行比字母行窄，`Ctrl/Win/Alt` 那行靠空格补齐。
 * 测试 `keyLayout.test.ts` 钉住「各行差值不超过 1.5 单位」。
 */
export function rowUnits(row: number): number {
  return (KEY_ROWS[row] ?? []).reduce((sum, key) => sum + unitsOf(key), 0);
}
