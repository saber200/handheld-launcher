/*
 * 修饰键（Shift / Caps / Shift 锁定）与手柄映射的测试。
 *
 * 为什么值得有：这套行为是**用户点名要的**（对标 OneXPlayer 的映射），而且三个状态
 * 互相作用（`shift` 按住 / `shiftLock` 锁定 / `caps` 大写），组合起来很容易出
 * 「按了没反应」或「状态卡住不放」这类 bug —— 那些在浏览器里手点很难覆盖全。
 *
 * 这里不测组件（那要跑 DOM），只测**纯逻辑**：`transformKey` 与那几个状态函数。
 * 它们不依赖 DOM，所以能在 Node 里直接跑。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPinyinTable } from "./pinyinTable.ts";

/** 每个用例都从干净状态开始：模块是单例，状态会跨用例残留。 */
async function fresh() {
  const mod = await import("./keyboard.ts");
  mod.resetKeyboardInput();
  mod.setKeyboardMode("en");
  return mod;
}

/**
 * 候选分页（用户 2026-10-16）的用例需要**真的有候选** —— 没有字表时引擎一个候选都
 * 切不出来。所以像 `pinyin.test.ts` 那样拦 `fetch` 读仓库里那份真表，走真链路。
 */
async function withTable<T>(run: () => T): Promise<T> {
  const body = readFileSync(join(process.cwd(), "public", "pinyin-syllables.txt"), "utf8");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, text: async () => body }) as unknown as Response) as typeof fetch;
  try {
    await loadPinyinTable();
    return run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** 中文模式下敲一串拼音并绑好一个单行输入框，返回（模块、插进框里的字、候选总数）。 */
async function composing(pinyin: string) {
  // 上一个用例 commit 候选时会往**内存里**的学习词表记词（Node 没有 localStorage，
  // 记忆仍在进程里活着），而学过的词会顶到候选条最前面 —— 不清掉，候选的总数与
  // 顺序就随用例顺序漂移。
  const learned = await import("./learned.ts");
  learned.forgetLearnedWords();
  const k = await fresh();
  const inserted: string[] = [];
  k.bindKeyboardField({
    insert: (text) => inserted.push(text),
    backspace: () => {},
    multiline: () => false,
  });
  k.setKeyboardMode("zh");
  for (const ch of pinyin) k.pressKey(ch);
  const total = k.keyboardState().candidates.length;
  assert.ok(total > 9, `前提：${pinyin} 的候选得超过一页（实际 ${total}）`);
  return { k, inserted, total };
}

test("默认状态下原样输出", async () => {
  const k = await fresh();
  assert.equal(k.transformKey("a"), "a");
  assert.equal(k.transformKey("1"), "1");
  assert.equal(k.transformKey("-"), "-");
});

test("Shift 按住：只影响字母与符号，且只影响这一次", async () => {
  const k = await fresh();
  k.setShift(true);
  assert.equal(k.transformKey("a"), "A");
  assert.equal(k.transformKey("1"), "!");
  assert.equal(k.transformKey("."), ">");
  assert.equal(k.transformKey("-"), "_");
  k.setShift(false);
  assert.equal(k.transformKey("a"), "a");
  assert.equal(k.transformKey("1"), "1");
});

test("Shift 锁定（L2）：一按锁上、再按一下松开", async () => {
  const k = await fresh();
  assert.equal(k.transformKey("a"), "a");
  k.toggleShiftLock();
  assert.equal(k.keyboardState().shiftLock, true, "按一下该锁上");
  assert.equal(k.transformKey("a"), "A");
  k.toggleShiftLock();
  assert.equal(k.keyboardState().shiftLock, false, "再按一下该松开");
  assert.equal(k.transformKey("a"), "a");
});

test("Caps（L3）：切换大写，且不自动松开", async () => {
  const k = await fresh();
  k.toggleCaps();
  assert.equal(k.transformKey("z"), "Z");
  // 连续多个字符都是大写 —— Caps 是锁定语义，不是「一个字符」
  assert.equal(k.transformKey("z"), "Z");
  // 符号也跟着走大写形态（锁定的语义是「Shift 一直按着」）
  assert.equal(k.transformKey("8"), "*");
  k.toggleCaps();
  assert.equal(k.transformKey("z"), "z");
});

test("中文组字时字母**必须保持小写** —— 否则拼音切不出来", async () => {
  const k = await fresh();
  k.setKeyboardMode("zh");
  k.toggleCaps();
  assert.equal(k.transformKey("n"), "n", "Caps 打开时拼音字母仍须小写");
  assert.equal(k.transformKey("i"), "i");
  k.setShift(true);
  assert.equal(k.transformKey("h"), "h", "Shift 按住时拼音字母仍须小写");
  // 但符号在中文模式下照样吃 Shift（用户要打 `！` 这类时靠它）
  assert.equal(k.transformKey("1"), "!");
});

test("关键盘会把三个修饰键状态一起复位", async () => {
  const k = await fresh();
  k.setShift(true);
  k.toggleShiftLock();
  k.toggleCaps();
  k.resetKeyboardInput();
  const state = k.keyboardState();
  assert.equal(state.shift, false, "按住状态不该跨会话残留");
  assert.equal(state.shiftLock, false);
  assert.equal(state.caps, false);
});

test("回车：多行框里先确认拼音再换行", async () => {
  const k = await fresh();
  const inserted: string[] = [];
  k.bindKeyboardField({
    insert: (text) => inserted.push(text),
    backspace: () => {},
    multiline: () => true, // textarea
  });
  k.setKeyboardMode("en");

  // 没组字时就是单纯一个回车
  k.pressEnter();
  assert.deepEqual(inserted, ["\n"]);

  // 中文模式下敲了两个字母 → 组字缓冲区里有东西
  k.setKeyboardMode("zh");
  k.pressKey("n");
  k.pressKey("i");
  assert.equal(k.keyboardState().composing, "ni");
  inserted.length = 0;
  k.pressEnter();
  // 应该先上屏「你」（候选里的第一个），再补一个回车
  assert.ok(inserted.length >= 1, "回车没上屏任何东西");
  assert.equal(inserted.at(-1), "\n", "回车最后要真的换行");
  assert.equal(k.keyboardState().composing, "", "回车之后不该还挂着组字");
  k.bindKeyboardField(null);
});

test("回车：单行输入框里不插换行，而是关键盘（等于「完成」）", async () => {
  const k = await fresh();
  const inserted: string[] = [];
  let closeRequested = 0;
  k.bindKeyboardCloseRequest(() => {
    closeRequested += 1;
  });
  k.bindKeyboardField({
    insert: (text) => inserted.push(text),
    backspace: () => {},
    multiline: () => false, // <input>
  });
  k.setKeyboardMode("zh");
  k.pressKey("n");
  k.pressKey("i");
  inserted.length = 0;

  k.pressEnter();
  // 拼音要上屏，但**不能**插换行（<input> 会把它吃掉，等于按了没反应）
  assert.ok(inserted.length >= 1, "回车该先把拼音上屏");
  assert.ok(!inserted.includes("\n"), "单行框里不该插入换行");
  assert.equal(closeRequested, 1, "单行框里回车该关掉键盘");
  k.bindKeyboardField(null);
  k.bindKeyboardCloseRequest(null);
});

test("中文模式下一个候选都没有时，回车要把拼音原文上屏（不能默默丢掉）", async () => {
  const k = await fresh();
  const inserted: string[] = [];
  k.bindKeyboardField({
    insert: (text) => inserted.push(text),
    backspace: () => {},
    multiline: () => false,
  });
  // 字表没加载时 `candidatesFor` 返回空 —— 模拟「字表没到位」或「用户其实在打英文词」
  k.setKeyboardMode("zh");
  k.pressKey("a");
  k.pressKey("p");
  k.pressKey("e");
  k.pressKey("x");
  assert.equal(k.keyboardState().composing, "apex", "字母该进组字缓冲");
  assert.equal(k.keyboardState().candidates.length, 0, "这个前提下不该有候选");

  inserted.length = 0;
  k.pressEnter();
  assert.ok(inserted.includes("apex"), `回车该把拼音原文上屏，实际插入了：${JSON.stringify(inserted)}`);
  assert.equal(k.keyboardState().composing, "", "上屏之后缓冲该清空");
  k.bindKeyboardField(null);
});

test("按住的 Shift 与锁定的 Shift 是两件独立的事", async () => {
  const k = await fresh();
  k.setShift(true);
  k.toggleShiftLock(); // 锁定
  k.setShift(false); // 松开 LT
  assert.equal(k.transformKey("a"), "A", "松开 LT 之后锁定仍应生效");
  k.toggleShiftLock(); // 解除锁定
  assert.equal(k.transformKey("a"), "a", "两次都松开后应回小写");
});

/* ── 候选分页（用户 2026-10-16：每页最多 9 颗，LB/RB 翻页，数字键选当前页） ── */

test("没在组字时翻页不消费、也不动状态", async () => {
  const k = await fresh();
  assert.equal(k.pageCandidate(1), false);
  assert.equal(k.pageCandidate(-1), false);
  assert.equal(k.keyboardState().selected, 0);
});

test("翻页：高亮整页地跳；首尾环绕", async () => {
  await withTable(async () => {
    const { k, total } = await composing("ni");
    const pages = Math.ceil(total / 9);

    // RB 一下 = 下一页同一位置：offset 0 → 第 10 颗（下标 9）
    assert.equal(k.pageCandidate(1), true);
    assert.equal(k.keyboardState().selected, 9);

    // 一路往后翻到最后一页（上面那次 RB 已到第 2 页，从第 3 页起继续），高亮落在页首；
    // 再翻一步环绕回第 0 页
    for (let page = 2; page < pages; page += 1) k.pageCandidate(1);
    assert.equal(k.keyboardState().selected, (pages - 1) * 9, "最后一页落在页首");
    k.pageCandidate(1);
    assert.equal(k.keyboardState().selected, 0, "最后一页再往后翻应环绕回第一页");

    // 第一页按 LB 直达最后一页（和逐颗移动的循环手感一致）
    k.pageCandidate(-1);
    assert.equal(k.keyboardState().selected, (pages - 1) * 9);
  });
});

test("翻页：满页之间页内位置保持；落进不满一页的最后一页时收在页内", async () => {
  await withTable(async () => {
    // 双音节 `niha` 的组合候选比单音节多得多（单音节被 HEAD_LIMIT=12 卡住，
    // 凑不满三页），这里专门拿它测「超过两页」的翻页。
    const { k, total } = await composing("niha");
    assert.ok(total >= 19, `前提：niha 的候选得超过两页（实际 ${total}）`);
    const pages = Math.ceil(total / 9);
    const lastHead = (pages - 1) * 9;
    const lastSize = total - lastHead;

    // 高亮挪到页内第 9 颗（下标 8）再翻一页：第 2 页是满页，offset 原样保持
    for (let i = 0; i < 8; i += 1) k.moveCandidate(1);
    k.pageCandidate(1);
    assert.equal(k.keyboardState().selected, 17, "满页之间页内位置应保持");

    // 一路翻到最后一页：offset 8 若超出最后一页的实际颗数，收成页内最后一颗
    for (let page = 2; page < pages; page += 1) k.pageCandidate(1);
    assert.equal(k.keyboardState().selected, lastHead + Math.min(8, lastSize - 1));
  });
});

test("翻页后按数字键 1 选的是**当前页**第 1 颗", async () => {
  await withTable(async () => {
    const { k, inserted } = await composing("ni");
    const candidates = k.keyboardState().candidates;
    k.pageCandidate(1);
    // 组件把「当前页第 1 颗」换算成 pageStart + 1 - 1 = 9（数字键选当前页的契约）
    k.commitCandidate(9);
    assert.equal(inserted.at(-1), candidates[9].text, "上屏的应是下一页的第 1 颗");
    assert.equal(k.keyboardState().composing, "", "上屏之后组字清空");
  });
});

test("页从 `selected` 推出来：逐颗移动跨过页边界时页跟着走", async () => {
  await withTable(async () => {
    const { k } = await composing("ni");
    // 连按 9 下右方向键 = moveCandidate(1)×9：高亮从 0 走到 9，页就从第 1 页走到第 2 页。
    // 状态机里没有独立的「页」字段，selected 就是唯一真相 —— 这里钉住这个不变量。
    for (let i = 0; i < 9; i += 1) assert.equal(k.moveCandidate(1), true);
    assert.equal(k.keyboardState().selected, 9);
    // 翻页函数看到的当前页也必须是第 2 页：往前翻一步落回第 1 页页首
    k.pageCandidate(-1);
    assert.equal(k.keyboardState().selected, 0);
  });
});
