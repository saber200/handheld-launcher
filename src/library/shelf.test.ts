/*
 * 屏保取图的优先级测试：`node scripts/test-web.mjs`
 *
 * 为什么值得有：这条顺序是照着**实测分辨率**排的（用户 2026-10-14 反馈「为啥这么糊」之后量的）：
 *
 *   | 图源 | 实际分辨率 | 铺满 1920 的放大倍数 |
 *   | --- | --- | --- |
 *   | library_600x900.jpg（CDN 实际下发） | 300×450 | 6.5 倍（糊） |
 *   | library_600x900_2x.jpg | 600×900 | 3.2 倍 |
 *   | library_hero.jpg | 1920×620 | 1 倍（清楚） |
 *
 * 顺序被谁"顺手优化"一下，用户看到的就是一屏糊图 —— 而这种问题在代码里完全看不出来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publishScreensaverCovers,
  screensaverCoverCandidates,
  screensaverCovers,
  subscribeScreensaverCovers,
} from "./shelf.ts";

test("Steam 游戏：宽幅大图排第一（它横向 1:1，铺满不用放大）", () => {
  const list = screensaverCoverCandidates({
    id: "steam:1245620",
    name: "艾尔登法环",
    cover: "asset://localhost/covers/steam_1245620.jpg",
    appId: "1245620",
  });
  assert.match(list[0], /library_hero\.jpg$/, "第一顺位必须是宽幅");
  assert.match(list[0], /\/1245620\//, "用的是这个游戏自己的 id");
  assert.match(list[1], /library_600x900_2x\.jpg$/, "第二顺位是竖版 2x");
  assert.equal(list[2], "asset://localhost/covers/steam_1245620.jpg", "第三顺位才是本地缓存");
});

test("非 Steam（Epic / 本地添加）：没有数字 id 就只用缓存那张，不许拿别人的图", () => {
  const list = screensaverCoverCandidates({
    id: "epic:abc",
    name: "某个 Epic 游戏",
    cover: "asset://localhost/covers/epic_abc.jpg",
  });
  assert.deepEqual(list, ["asset://localhost/covers/epic_abc.jpg"]);
});

test("线上兜底排在最后", () => {
  const list = screensaverCoverCandidates({
    id: "steam:730",
    name: "CS2",
    cover: "asset://localhost/covers/steam_730.jpg",
    coverRemote: "https://cdn.cloudflare.steamstatic.com/steam/apps/730/library_600x900.jpg",
    appId: "730",
  });
  assert.equal(list.length, 4);
  assert.match(list[3], /^https:/, "最后一个是线上兜底");
});

test("appId 不是纯数字时不拼地址（免得拼出一个奇怪的 URL 去打 CDN）", () => {
  for (const bad of ["", "abc", "12 34", "../etc", "1".repeat(12)]) {
    const list = screensaverCoverCandidates({
      id: "steam:x",
      name: "x",
      cover: "asset://localhost/c.jpg",
      appId: bad,
    });
    assert.deepEqual(list, ["asset://localhost/c.jpg"], `appId=${JSON.stringify(bad)} 不该拼出地址`);
  }
});

test("登记处：没封面的不收（手动添加的游戏没有图，混进轮播就是一格黑）", () => {
  publishScreensaverCovers([
    { id: "a", name: "有图", cover: "asset://c/a.jpg", appId: "1" },
    { id: "b", name: "没图", cover: "" },
  ]);
  assert.deepEqual(
    screensaverCovers().map((item) => item.id),
    ["a"],
  );
});

test("登记处：内容没变就不通知（GamesPage 每次渲染都会调它）", () => {
  publishScreensaverCovers([{ id: "a", name: "有图", cover: "asset://c/a.jpg", appId: "1" }]);
  let notified = 0;
  const off = subscribeScreensaverCovers(() => {
    notified += 1;
  });
  // 内容完全相同（新数组、新对象）→ 不通知
  publishScreensaverCovers([{ id: "a", name: "有图", cover: "asset://c/a.jpg", appId: "1" }]);
  assert.equal(notified, 0, "逐项相同就不该通知");
  // 封面地址变了 → 通知一次
  publishScreensaverCovers([{ id: "a", name: "有图", cover: "asset://c/a2.jpg", appId: "1" }]);
  assert.equal(notified, 1, "封面换了要通知");
  // appId 出现/消失也算变化（它决定屏保能不能取到高清图）
  publishScreensaverCovers([{ id: "a", name: "有图", cover: "asset://c/a2.jpg", appId: "2" }]);
  assert.equal(notified, 2, "appId 变了也要通知");
  off();
});
