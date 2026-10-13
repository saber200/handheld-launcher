/*
 * 键面覆盖与排布的自动化核对：`node scripts/test-web.mjs`
 *
 * 为什么值得有：这把键盘是**给手柄用的唯一输入手段**（系统触摸键盘的入口 2026-10-13
 * 已下线），所以「某个常用符号打不出来」是实打实的功能缺失。而键表是一堆字符串字面量，
 * 少写一行、漏一个字符、多写两个键，build 和 tsc 都看不出来。
 *
 * 这不是假想的问题 —— 调这个布局真踩了三次，每次都是靠这类断言发现的：
 *   ① 补符号时漏掉一整行（`! # $ % & * + , ; : ? =` 全没了）；
 *   ② 补回来那行写成 12 键（超过每行 10 键的上限）；
 *   ③ 两层不等高（切层时键盘往上跳 52px）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CJK_PUNCT, allReachableCharacters, rowsForLayer } from "./keyLayout.ts";

const reachable = allReachableCharacters();
/** 每行键数上限：再多就挤成一团，掌机上离眼 30cm 看不清。 */
const MAX_KEYS_PER_ROW = 10;

test("整套 ASCII 可打印字符（94 个）在键盘上都能打出来", () => {
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

test("字母大小写都能打", () => {
  for (const ch of "abcdefghijklmnopqrstuvwxyz") {
    assert.ok(reachable.has(ch), `小写 ${ch} 打不出来`);
    assert.ok(reachable.has(ch.toUpperCase()), `大写 ${ch.toUpperCase()} 打不出来`);
  }
});

test("文件名里常见的符号一个都不缺", () => {
  // 真实出现在文件名 / 目录名里的那些（含 `@eaDir`、`~$xxx.docx` 这类）
  const used = [".", "-", "_", "(", ")", "[", "]", "@", "~", "&", "+", "'", ",", "!", "#", "$", "%", "^", "{", "}", "|", "\\", "<", ">", "/", "?", "=", ":", ";", "*"];
  const missing = used.filter((ch) => !reachable.has(ch));
  assert.deepEqual(missing, [], `文件名常见符号打不出来：${missing.join(" ")}`);
});

test("中文常用标点一个都不缺", () => {
  // 中文里最高频的那批。破折号是一个键打两个字符，所以按「字符」判可达性。
  const used = "，。、；：？！…—·";
  const missing = [...used].filter((ch) => !reachable.has(ch));
  assert.deepEqual(missing, [], `中文标点打不出来：${missing.join(" ")}`);
});

test(`每行键数不超过 ${MAX_KEYS_PER_ROW}（再多会挤成一团）`, () => {
  for (const layer of ["letters", "symbols"] as const) {
    for (const row of rowsForLayer(layer)) {
      assert.ok(
        row.keys.length <= MAX_KEYS_PER_ROW,
        `${layer} 层有一行是 ${row.keys.length} 个键：「${row.keys.join("")}」`,
      );
    }
  }
});

test("两层行数相同（否则切层时键盘高度会跳）", () => {
  const letters = rowsForLayer("letters");
  const symbols = rowsForLayer("symbols");
  assert.equal(
    symbols.length,
    letters.length,
    `字母层 ${letters.length} 行、符号层 ${symbols.length} 行 —— 切层时键盘高度会变`,
  );
});

test("两层的中文标点行完全一致（切层时这一行不动）", () => {
  const last = (layer: "letters" | "symbols") => rowsForLayer(layer).at(-1)?.keys;
  assert.deepEqual(last("letters"), CJK_PUNCT);
  assert.deepEqual(last("symbols"), CJK_PUNCT);
});

test("占位行只出现在字母层，且它确实占位置", () => {
  const letters = rowsForLayer("letters");
  const fillers = letters.filter((row) => row.filler);
  assert.ok(fillers.length >= 1, "字母层应该补占位行（它是行数少的那层）");
  assert.equal(rowsForLayer("symbols").filter((row) => row.filler).length, 0, "符号层是行数多的那层，不需要占位");
  // 占位行必须有键（哪怕不显示）—— 空的 div 不占高度，两层就又不齐了
  for (const row of fillers) {
    assert.ok(row.keys.length > 0, "占位行不该是空的（否则不占高度）");
  }
});
