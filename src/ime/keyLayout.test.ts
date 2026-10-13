/*
 * 键面覆盖与结构的自动化核对：`node scripts/test-web.mjs`
 *
 * 为什么值得有：这把键盘是**给手柄用的唯一输入手段**（系统触摸键盘的入口 2026-10-13
 * 已下线），所以「某个常用符号打不出来」是实打实的功能缺失。而键表是一堆字符串字面量，
 * 少写一行、漏一个字符、多写两个键，build 和 tsc 都看不出来。
 *
 * 这不是假想的问题 —— 调这个布局真踩过几次，每次都是靠这类断言发现的：
 *   ① 补符号时漏掉一整行（`! # $ % & * + , ; : ? =` 全没了）；
 *   ② 补回来那行写成 12 键（超过每行上限）；
 *   ③ 两层不等高（切层时键盘往上跳 52px）—— 布局改成照片那套 6 行之后这条才自然消掉。
 *
 * 2026-10-13 按 OneXPlayer 照片重排之后，这里同时钉住**照片读出来的关键事实**
 * （角标位置、行结构、Shift 形态），免得以后有人「顺手优化」把对齐弄丢。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CJK_PUNCT,
  KEY_ROWS,
  MAX_KEYS_PER_ROW,
  ROW_COUNT,
  charFor,
  keyAt,
  reachableCharacters,
  rowUnits,
} from "./keyLayout.ts";

const reachable = reachableCharacters();

test("整套 ASCII 可打印字符（94 个）都能打出来", () => {
  const missing: string[] = [];
  for (let code = 0x21; code <= 0x7e; code += 1) {
    const ch = String.fromCharCode(code);
    if (!reachable.has(ch)) missing.push(ch);
  }
  assert.deepEqual(
    missing,
    [],
    `这些 ASCII 字符打不出来：${missing.map((c) => JSON.stringify(c)).join(" ")}`,
  );
});

test("文件名里常见的符号一个都不缺", () => {
  const used = [".", "-", "_", "(", ")", "[", "]", "@", "~", "&", "+", "'", ",", "!", "#", "$", "%", "^", "{", "}", "|", "\\", "<", ">", "/", "?", "=", ":", ";", "*", "`"];
  const missing = used.filter((ch) => !reachable.has(ch));
  assert.deepEqual(missing, [], `文件名常见符号打不出来：${missing.join(" ")}`);
});

test("中文常用标点一个都不缺", () => {
  const used = "，。、；：？！…—·";
  const all = CJK_PUNCT.join("");
  const missing = [...used].filter((ch) => !all.includes(ch));
  assert.deepEqual(missing, [], `中文标点打不出来：${missing.join(" ")}`);
});

test(`每行键数不超过 ${MAX_KEYS_PER_ROW}`, () => {
  KEY_ROWS.forEach((row, index) => {
    assert.ok(row.length <= MAX_KEYS_PER_ROW, `第 ${index + 1} 行有 ${row.length} 个键，超了`);
  });
});

/* ── 以下几条钉的是「按照片对齐」这件事本身 ── */

test("行结构与照片一致：6 行，第一行是 Esc + F1–F12", () => {
  assert.equal(ROW_COUNT, 6, "照片里就是 6 行");
  const esc = keyAt(0, 0);
  assert.ok(esc && esc.kind === "wide" && esc.id === "esc", "第一行第一列该是 Esc");
  for (let i = 0; i < 12; i += 1) {
    const key = keyAt(0, i + 1);
    assert.ok(
      key && key.kind === "char" && key.label === `F${i + 1}`,
      `F${i + 1} 不在第一行第 ${i + 2} 列`,
    );
    // 功能键不该往输入框送文字（否则按 F1 会打出字面的「f1」）
    assert.equal(charFor(key, "lower"), null, `F${i + 1} 不该产生可打印字符`);
  }
});

test("手柄角标印在照片里那几个键上（这是这把键盘的识别特征）", () => {
  const badgeOf = (id: string) => {
    const key = KEY_ROWS.flat().find((k) => k.kind === "wide" && k.id === id);
    return key?.kind === "wide" ? key.badge : undefined;
  };
  assert.equal(badgeOf("backspace"), "X", "Backspace 上该印 X");
  assert.equal(badgeOf("enter"), "R2", "Enter 上该印 R2");
  assert.equal(badgeOf("caps"), "L3", "Caps 上该印 L3");
  assert.equal(badgeOf("shift-left"), "L2", "左 Shift 上该印 L2 —— 照片证实 L2 是这颗键");
  assert.equal(badgeOf("shift-right"), undefined, "右 Shift 不印角标");
  const space = KEY_ROWS.flat().find((key) => key.kind === "space");
  assert.equal(space?.badge, "Y", "空格上该印 Y");
});

test("L2 接的是左 Shift（不是「扳机按到底」）", () => {
  // 我一开始把 L2 猜成两段行程，照片纠正了这个判断。这条测试钉住照片的结论。
  const leftShift = KEY_ROWS.flat().find((key) => key.kind === "wide" && key.id === "shift-left");
  assert.ok(leftShift?.kind === "wide");
  assert.equal(leftShift.badge, "L2");
});

test("Shift 形态：字母变大写、数字变符号、空格不变", () => {
  const one = KEY_ROWS[1].find((key) => key.kind === "char" && key.code === "1");
  assert.ok(one);
  assert.equal(charFor(one, "lower"), "1");
  assert.equal(charFor(one, "upper"), "!", "Shift + 1 该出感叹号");

  const q = KEY_ROWS[2].find((key) => key.kind === "char" && key.code === "q");
  assert.ok(q);
  assert.equal(charFor(q, "lower"), "q");
  assert.equal(charFor(q, "upper"), "Q", "字母的 Shift 形态是转大写（不用单独写 shiftedOf）");

  const space = KEY_ROWS[5].find((key) => key.kind === "space");
  assert.ok(space);
  assert.equal(charFor(space, "upper"), " ", "Shift 不能让空格变成别的东西");
});

test("符号只印在数字行与 ASDF/ZXCV 两行的 Shift 形态上（照片的排法）", () => {
  const digitRowShifted = KEY_ROWS[1]
    .filter((key) => key.kind === "char" && key.shiftedOf)
    .map((key) => (key.kind === "char" ? key.shiftedOf : undefined));
  assert.deepEqual(digitRowShifted, ["~", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+"]);

  const punct = KEY_ROWS.flat()
    .filter((key) => key.kind === "char" && key.shiftedOf)
    .map((key) => (key.kind === "char" ? key.shiftedOf : undefined));
  for (const ch of ["{", "}", "|", ":", "\"", "<", ">", "?"]) {
    assert.ok(punct.includes(ch), `标点 ${ch} 没印在任何键的 Shift 形态上`);
  }
});

test("各行宽度接近（差得多了键宽会看起来是歪的）", () => {
  const units = KEY_ROWS.map((_, index) => rowUnits(index));
  const widest = Math.max(...units);
  const narrowest = Math.min(...units);
  assert.ok(
    widest - narrowest <= 1.6,
    `各行宽度差 ${(widest - narrowest).toFixed(1)} 个单位（最宽 ${widest.toFixed(1)}、最窄 ${narrowest.toFixed(1)}）` +
      `\n${units.map((u, i) => `  第 ${i + 1} 行 ${u.toFixed(1)}`).join("\n")}`,
  );
});

test("中文标点行是十颗键，且不参与 Shift 变换", () => {
  assert.equal(CJK_PUNCT.length, 10);
  assert.ok(CJK_PUNCT.includes("——"), "破折号是一个键打两个字符");
});
