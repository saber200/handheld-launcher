/*
 * 屏保开关状态机的测试：`node scripts/test-web.mjs`
 *
 * 为什么值得有：这一层只有三个状态（关着 / 开着 / 正在淡出），但每个状态对应一条
 * **输入该不该被吞掉**的规矩，错一条就是真机上的误触事故。开发时真踩过一个：
 * 屏保弹出来的下一帧就把自己的空闲状态顶掉、自己把自己关了（真机上是"闪一下没了"，
 * 无头浏览器里因为采样间隔看起来像"每 4 秒闪一下"）。这类问题在代码里看不出来，
 * 只能拿断言钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScreensaverOverlay, SCREENSAVER_FADE_MS } from "./overlay.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("初始是关着的，既不该吞输入也不该等重采样", () => {
  const overlay = new ScreensaverOverlay();
  assert.equal(overlay.snapshot(), 0);
  assert.equal(overlay.suppressInput(), false);
  assert.equal(overlay.pendingResync(), false);
});

test("打开之后要吞输入（屏保上按 A 不能穿透到界面）", () => {
  const overlay = new ScreensaverOverlay();
  overlay.show();
  assert.equal(overlay.snapshot(), 1);
  assert.equal(overlay.suppressInput(), true);
});

test("重复 show 不会重复通知（effect 每次渲染都会调它）", () => {
  const overlay = new ScreensaverOverlay();
  let count = 0;
  overlay.subscribe(() => {
    count += 1;
  });
  overlay.show();
  overlay.show();
  overlay.show();
  assert.equal(count, 1);
  assert.equal(overlay.snapshot(), 1);
});

test("关掉要走两个阶段：先淡出、再消失", async () => {
  const overlay = new ScreensaverOverlay();
  overlay.show();
  overlay.requestClose();
  assert.equal(overlay.snapshot(), 2, "立刻进入淡出");
  assert.equal(overlay.suppressInput(), false, "淡出期间不再吞输入，否则用户按不动了");
  assert.equal(overlay.pendingResync(), true, "这时候要重新采一遍按键状态");
  await sleep(SCREENSAVER_FADE_MS + 60);
  assert.equal(overlay.snapshot(), 0, "淡出结束才算真的没了");
});

test("立刻关（窗口切走）不演淡出", () => {
  const overlay = new ScreensaverOverlay();
  overlay.show();
  overlay.closeNow();
  assert.equal(overlay.snapshot(), 0);
  assert.equal(overlay.pendingResync(), true, "不管走不走淡出，唤醒那一下都要重新采样");
});

test("resynced 之后就不再要求重采样（tick 每帧问一次，不能一直问）", () => {
  const overlay = new ScreensaverOverlay();
  overlay.show();
  overlay.requestClose(true);
  assert.equal(overlay.pendingResync(), true);
  overlay.resynced();
  assert.equal(overlay.pendingResync(), false);
});

test("没开着的时候关它是空操作，不该打扰订阅者", () => {
  const overlay = new ScreensaverOverlay();
  let count = 0;
  overlay.subscribe(() => {
    count += 1;
  });
  overlay.requestClose();
  overlay.closeNow();
  assert.equal(count, 0);
  assert.equal(overlay.pendingResync(), false, "没开过就不存在「唤醒那一下」的问题");
});

test("淡出还没结束又按一次，仍然只关一次", async () => {
  const overlay = new ScreensaverOverlay();
  overlay.show();
  let count = 0;
  overlay.subscribe(() => {
    count += 1;
  });
  overlay.requestClose();
  overlay.requestClose();
  assert.equal(count, 1, "第二次不该再发一遍'开始淡出'");
  await sleep(SCREENSAVER_FADE_MS + 60);
  assert.equal(overlay.snapshot(), 0);
});

test("淡出中重新 show：取消关闭，回到开着", async () => {
  const overlay = new ScreensaverOverlay();
  overlay.show();
  overlay.requestClose();
  overlay.show();
  assert.equal(overlay.snapshot(), 1);
  assert.equal(overlay.suppressInput(), true);
  // 等过原本那个淡出时限，确认它没有被那个残留的定时器关掉。
  await sleep(SCREENSAVER_FADE_MS + 60);
  assert.equal(overlay.snapshot(), 1, "重新打开之后不该被上一次的定时器收走");
});
