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
import { test } from "node:test";
import assert from "node:assert/strict";

/** 每个用例都从干净状态开始：模块是单例，状态会跨用例残留。 */
async function fresh() {
  const mod = await import("./keyboard.ts");
  mod.resetKeyboardInput();
  mod.setKeyboardMode("en");
  return mod;
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
