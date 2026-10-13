/*
 * 手柄键盘的**键面布局**（纯数据，不含任何 React）。
 *
 * 单独拆出来的理由：布局是「我们承诺能打出哪些字符」这件事的**唯一事实来源**，
 * 而这件事需要一个自动化测试盯着（`keyLayout.test.ts` 检查整套 ASCII 与中文常用标点
 * 是否都可达）。测试用 Node 跑、不引 React，所以这份数据不能和组件混在一个文件里。
 *
 * 改键表时**不要**直接改 `GamepadKeyboard.tsx` —— 改这里，然后跑 `npm test`。
 */

/**
 * 键盘分**两层**（像手机上的 `ABC` / `?123`），两层都是 4 行字符键 + 1 行中文标点：
 *
 *   | 层 | 4 行字符键 | 最后一行 |
 *   |---|---|---|
 *   | 字母层 | `qwertyuiop` / `asdfghjkl` / `zxcvbnm` / **占位** | 共用的中文标点 |
 *   | 符号层 | 数字一行 + ASCII 标点三行 | 共用的中文标点 |
 *
 * ## 为什么字母层要留一行占位（本文件里最费劲的一条约束）
 *
 * 键盘是贴着屏幕底边弹出的**固定高度面板**，切层时高度一变，整把键盘会往上跳一下
 * （实测差 52px，很难看）。而这里有个硬算术：
 *
 *   - 符号层要装 **42 个键位**（数字 10 + ASCII 可打印标点 32），每行最多 10 键 → **必须 4 行**；
 *   - 字母层只有 26 个字母 → **3 行就够**。
 *
 * 差一行就是 52px 的跳动。所以字母层补一行**占位键**（`visibility: hidden`：占高度、
 * 不显示、也不参与焦点），把两层拉齐。占位行不参与「能打出哪些字」的判定。
 *
 * ## 42 个键位怎么塞进 4×10
 *
 * 数字 10 个占满第一行，剩 32 个标点分三行：10 + 10 + 10 只装得下 30，还差 2 个。
 * 所以 ` （反引号）与 | （竖线）放在最后一行单独收尾（见 `SYMBOL_ROWS` 第 5 项）——
 * 这两个是 ASCII 里最不可能出现在文件名中的，为它们破坏整行节奏不值得。
 *
 * 一路调这个布局踩了三次坑，三条现在都有测试盯着：
 * ① 补符号时**漏掉一整行**（`! # $ % & * + , ; : ? =` 全没了）；
 * ② 补回来那行写成 **12 键**（超过每行 10 键的上限）；
 * ③ 两层**不等高**（切层时键盘跳一下）。
 */
export const LETTER_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"] as const;

/** 字母层的占位行：只为把高度拉齐，不显示、不可聚焦。 */
export const LETTER_FILLER_ROW = "xxxx" as const;

/**
 * 符号层的 ASCII 符号：数字一行 + 标点三行 + 收尾一行。
 *
 * **整套 94 个 ASCII 可打印字符全部可达**（大小写字母来自字母层、空格有独立键）。
 * 最常用的排前面（`.` `-` `_` 在文件名里出现最多）。
 */
export const SYMBOL_ROWS = [
  "1234567890", // 数字占满一行 —— 顺便把「数字键」这件事解决掉
  ".-_@(),;:?",
  "!*/\\~'\"<>^",
  "#$%&+=[]{}",
  "`|", // ASCII 里最冷门的两个，单独一行收尾（理由见文件头）
] as const;

/**
 * 中文标点，两层共用**同一行**（切层时这一行不动，用户的位置感不会丢）。
 *
 * 挑的是中文里最高频的十个：逗号句号问号感叹号顿号冒号分号省略号破折号间隔号。
 * 注意 **`——` 是一个键打出两个字符** —— 中文破折号本来就占两格，所以它在这份表里
 * 是一个长度为 2 的字符串，覆盖检查要按「字符集合」而不是「单字符」来判。
 *
 * **全角引号与括号（`“”《》【】`）没有单独摆键**：它们和符号层已有的
 * `" ' < > [ ] { }` 是同一个键的两个形态，而中文输入场景里更常打的是逗号句号那一批。
 * 真需要全角引号时，先用候选条打中文、再打半角引号，读起来是一样的。
 */
export const CJK_PUNCT = ["，", "。", "？", "！", "、", "：", "；", "…", "——", "·"] as const;

/**
 * 每层**内容行**的目标行数：两层的数必须一致，否则切层时键盘高度会跳。
 *
 * 由符号层决定 —— 42 个键位（数字 10 + ASCII 标点 32）在每行 10 键的上限下至少要 5 行，
 * 所以取 5。字母层只有 3 行字母，剩下的两行用占位行补齐。
 */
const CONTENT_ROWS = SYMBOL_ROWS.length;

export type KeyboardLayer = "letters" | "symbols";

/** 一行键。`filler` 的行为占位行：占高度、不显示、不可聚焦。 */
export type KeyRow = { keys: readonly string[]; filler?: boolean };

/**
 * 某一层的全部字符键行（不含底部那颗层切换键与空格 / 删除 / 完成）。
 *
 * 末行永远是共用的中文标点，两层的字符键行数也相同 —— 于是**总行数必然一致**，
 * 切层时键盘高度不变。这两条都由 `keyLayout.test.ts` 保证。
 */
export function rowsForLayer(layer: KeyboardLayer): KeyRow[] {
  const content: KeyRow[] =
    layer === "letters"
      ? LETTER_ROWS.map((row) => ({ keys: [...row] }))
      : SYMBOL_ROWS.map((row) => ({ keys: [...row] }));

  // 占位行的**数量是算出来的，不是写死的** —— 写死过一次（写 1 行，而符号层比字母层
  // 多 2 行），于是两层还是不等高。哪一层内容行少就补几行到 CONTENT_ROWS。
  const fillerCount = CONTENT_ROWS - content.length;
  const fillers: KeyRow[] = Array.from({ length: Math.max(fillerCount, 0) }, () => ({
    keys: [...LETTER_FILLER_ROW],
    filler: true,
  }));
  return [...content, ...fillers, { keys: CJK_PUNCT }];
}

/** 两层合起来能打出的**全部字符**（展开 `——` 这种多字符键，字母补上大写）。 */
export function allReachableCharacters(): Set<string> {
  const out = new Set<string>();
  for (const layer of ["letters", "symbols"] as const) {
    for (const row of rowsForLayer(layer)) {
      if (row.filler) continue;
      for (const key of row.keys) {
        for (const ch of key) out.add(ch);
        // 字母键没有单独的 Shift，但候选与输入框都吃大写，所以大写也算可达
        if (key.length === 1 && /[a-z]/.test(key)) out.add(key.toUpperCase());
      }
    }
  }
  out.add(" "); // 空格有独立键
  return out;
}
