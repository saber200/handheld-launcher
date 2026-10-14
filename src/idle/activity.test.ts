/*
 * 空闲计时的测试：`node scripts/test-web.mjs`
 *
 * 为什么值得有：屏保的触发条件是**时间**，而这正是肉眼最难验的东西 —— 手动试一次要坐着
 * 等一分钟，还只能试到「一分钟左右弹了」，试不出「58 秒时上报活动是否真的把计时清零」
 * 「切出去又切回来会不会立刻弹屏保」这种边角。这里的时钟和可见性都是注入口，
 * 所以这些都是**确定性**断言，不用等真实时间。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleTracker, IDLE_TIMEOUT_MS } from "./activity.ts";

/** 可手动推进的假时钟 + 可手动切换的假可见性。 */
function harness(timeoutMs = IDLE_TIMEOUT_MS) {
  let clock = 1_000;
  let visible = true;
  const tracker = new IdleTracker(timeoutMs, () => clock, () => visible);
  return {
    tracker,
    advance(ms: number) {
      clock += ms;
    },
    setVisible(next: boolean) {
      visible = next;
    },
    /** 模拟定时器到点：真实实现里这是 setTimeout 回调，这里是「读一次快照」。 */
    tick() {
      return tracker.snapshot();
    },
  };
}

test("默认阈值就是一分钟", () => {
  assert.equal(IDLE_TIMEOUT_MS, 60_000);
});

test("刚开始不算空闲，到点才算", () => {
  const h = harness();
  assert.equal(h.tick(), false, "刚构造出来不该是空闲");
  h.advance(59_999);
  assert.equal(h.tick(), false, "差 1 毫秒都不该弹");
  h.advance(1);
  assert.equal(h.tick(), true, "满一分钟必须弹");
});

test("差一点到点时上报活动，计时从零开始", () => {
  const h = harness();
  h.advance(59_000);
  h.tracker.markActivity();
  h.advance(59_000);
  assert.equal(h.tick(), false, "上报过活动的 59 秒不该弹");
  h.advance(1_000);
  assert.equal(h.tick(), true, "从上报那一刻算满一分钟才弹");
});

test("markActivity 会把已经弹出来的屏保收回去，且只回报一次", () => {
  const h = harness();
  h.advance(IDLE_TIMEOUT_MS);
  assert.equal(h.tick(), true, "先弹出来");
  assert.equal(h.tracker.markActivity(), true, "这一下确实关掉了屏保");
  assert.equal(h.tracker.markActivity(), false, "屏保已经关了，第二下不该再报");
  assert.equal(h.tick(), false);
});

test("屏保开着时按键：状态立刻翻转，不用等下一次定时器", () => {
  const h = harness();
  const seen: boolean[] = [];
  h.tracker.subscribe(() => seen.push(h.tracker.snapshot()));

  h.advance(IDLE_TIMEOUT_MS);
  h.tick();
  assert.deepEqual(seen, [true], "弹出时通知了一次");

  h.tracker.markActivity();
  assert.deepEqual(seen, [true, false], "按键后立刻通知收回");
});

test("窗口不可见时永远不算空闲（用户多半正在玩游戏）", () => {
  const h = harness();
  h.setVisible(false);
  h.advance(IDLE_TIMEOUT_MS * 10);
  assert.equal(h.tick(), false, "最小化时不该弹屏保");
});

test("不可见期间攒下的时间不算数；切回来重新计时", () => {
  const h = harness();
  h.setVisible(false);
  h.advance(IDLE_TIMEOUT_MS * 3);
  h.setVisible(true);
  h.tracker.visibilityChanged();
  h.advance(59_000);
  assert.equal(h.tick(), false, "切回来 59 秒不该弹");
  h.advance(1_000);
  assert.equal(h.tick(), true, "切回来满一分钟才弹");
});

test("切走时屏保要收掉", () => {
  const h = harness();
  h.advance(IDLE_TIMEOUT_MS);
  assert.equal(h.tick(), true, "先弹出来");
  h.setVisible(false);
  h.tracker.visibilityChanged();
  assert.equal(h.tracker.snapshot(), false, "切走之后不该还挂着屏保");
});

test("快照会跟着时间走，不是缓存的旧值", () => {
  const h = harness();
  assert.equal(h.tracker.snapshot(), false);
  h.advance(IDLE_TIMEOUT_MS);
  // 关键：中间没有任何 poll / 定时器回调，直接读快照也必须是最新的。
  assert.equal(h.tracker.snapshot(), true);
});

test("没有订阅者时不排定时器，也就不会空转", () => {
  const h = harness();
  const off = h.tracker.subscribe(() => {});
  h.advance(IDLE_TIMEOUT_MS);
  assert.equal(h.tracker.snapshot(), true);
  off();
  // 退订之后状态查询仍然正确（只是不再主动通知），这里确认退订不炸。
  assert.equal(h.tracker.snapshot(), true);
});
