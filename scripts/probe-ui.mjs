#!/usr/bin/env node
/*
 * 真渲染探针：把跑起来的界面按指定窗口尺寸渲染出来，量盒子、查「焦点环有没有被滚动容器裁掉」、
 * 存截图。**不在 CI 里跑**（要本机 Chrome + 一个跑着的 dev server + 网络拉封面），
 * 是给逐页迁移时自查用的 —— `audit-ui.mjs` 扫的是源码，它量的是实际像素，两者互补。
 *
 * 用法（先另开一个终端 `npm run dev`）：
 *   node scripts/probe-ui.mjs                      # 默认 1280x720 与 1920x1080
 *   node scripts/probe-ui.mjs --size 1280x720      # 只量一个尺寸
 *   node scripts/probe-ui.mjs --url http://localhost:1420/ --shots /tmp/ui-shots
 *   CHROME_PATH=/path/to/chrome node scripts/probe-ui.mjs
 *
 * 为什么用 DevTools 协议而不是 `chrome --screenshot --window-size`：headless 下的
 * --window-size 会比指定值矮（浏览器自己占了条），`--dp` 跟着算错，量出来的坐标没法跟画板对。
 * 走 Emulation.setDeviceMetricsOverride 才是真尺寸。
 *
 * 为什么零依赖：跟 audit-ui.mjs 一个理由 —— 工程里没有 puppeteer，也不想为一次性验证引一个。
 * Node 20+ 自带 fetch 与 WebSocket，够用。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const URL = argOf("--url", "http://localhost:1420/");
const SIZES = argOf("--size", "1280x720,1920x1080")
  .split(",")
  .map((s) => s.split("x").map(Number));
const SHOTS = argOf("--shots", "");
/** 环外扩 = --focus-offset(4) + --focus-stroke(3)。改了令牌这里也要改（audit 会盯着 tokens.css）。 */
const RING = 7;

/**
 * 已知「环会被裁」但**故意留到对应里程碑**再修的容器（旧页面还走旧 px 布局，现在改会和
 * 那一页的视觉改动撞在一起）。新出现的条目一律算失败 —— 这份名单只许变短。
 * 软件库 K2（M2）、文件页 K7（M3）迁完就删。
 */
const KNOWN_RING_CLIP = ["library-grid", "file-list", "page"];

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error("找不到 Chrome —— 用 CHROME_PATH=/path/to/chrome 指定一个。");
    process.exit(2);
  }
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个 headless Chrome 并接上第一个页面目标，返回发命令 / 跑页面脚本 / 截图的能力。 */
async function connect({ width, height }) {
  const profile = mkdtempSync(join(tmpdir(), "probe-ui-"));
  const child = spawn(
    chromePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const deadline = Date.now() + 20000;
  let port = 0;
  while (Date.now() < deadline && !port) {
    try {
      // 真实端口写在 profile 的 DevToolsActivePort 第一行（--remote-debugging-port=0 时随机分配）
      port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    } catch {
      await sleep(150);
    }
  }
  if (!port) throw new Error("Chrome 没起来");

  let target = null;
  while (Date.now() < deadline && !target) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!target) await sleep(150);
  }
  if (!target) throw new Error("没有可用的页面目标");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const waiters = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      return;
    }
    const list = waiters.get(msg.method);
    if (list?.length) list.shift()(msg.params);
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const once = (method) =>
    new Promise((res) => {
      if (!waiters.has(method)) waiters.set(method, []);
      waiters.get(method).push(res);
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  return {
    send,
    async goto(url) {
      const loaded = once("Page.loadEventFired");
      await send("Page.navigate", { url });
      await loaded;
    },
    wait: sleep,
    /** 在页面里跑一段脚本（可写 await），返回可 JSON 化的值。 */
    async eval(script) {
      const r = await send("Runtime.evaluate", {
        expression: `(async () => { ${script} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "页面里抛错了");
      return r.result.value;
    },
    async shot(path, clip) {
      const r = await send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" });
      writeFileSync(path, Buffer.from(r.data, "base64"));
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* 已经断了 */
      }
      child.kill("SIGKILL");
      // 临时 profile 是 Chrome 的，SIGKILL 之后它还在写盘 —— 立刻删会 ENOTEMPTY
      // （真遇到过，整个探针会在这里崩掉）。等一会儿再删，仍然失败就算了：
      // 那是系统临时目录，不该影响「检查是否通过」这个结论。
      await sleep(300);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* 留给系统清理 */
      }
    },
  };
}

// ── 检查一：几何（跟画板 §3.1 的绝对坐标对） ──

const GEOMETRY = `
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
             bottom: +(r.y + r.height).toFixed(2), centerX: +(r.x + r.width / 2).toFixed(2) };
  };
  const strip = document.querySelector('.k1-strip');
  return {
    dp: +(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1),
    viewport: [innerWidth, innerHeight],
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    hero: box('.k1-hero'), strip: box('.k1-strip'), card: box('.k1-item.is-current'),
    panel: box('.k1-panel'), chip: box('.group-chip'), navFirst: box('.nav-item'),
    stripCenter: strip ? +(strip.getBoundingClientRect().x + strip.clientWidth / 2).toFixed(2) : null,
  };
`;

/** 点一次方向键（走的是和手柄同一条 moveDirectionalFocus 路径）。 */
const arrow = async (page, key) => {
  const code = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 }[key];
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: code });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
  await sleep(400);
};

const focused = (page) =>
  page.eval(`
    const a = document.activeElement;
    const z = a.closest('[data-focus-zone]');
    return (z ? z.getAttribute('data-focus-zone') : '-') + ' | ' + (a.className || '').split(' ')[0] + ' | ' + (a.textContent || '').trim().slice(0, 10);
  `);

// ── 检查二：焦点环有没有被 overflow 祖先裁掉 ──
// 判据：元素自己是完整可见的（不然它本来就在可视区外），但外扩 RING 的框超出了某个
// `overflow` 祖先的内边距盒 —— 裁切发生在内边距盒边界，不是边框盒。

const RING_CLIP = `
  const RING = ${RING};
  const out = [];
  for (const el of document.querySelectorAll('[data-focusable]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const clipX = /auto|scroll|hidden|clip/.test(cs.overflowX);
      const clipY = /auto|scroll|hidden|clip/.test(cs.overflowY);
      if (!clipX && !clipY) continue;
      const pr = p.getBoundingClientRect();
      const box = {
        left: pr.left + parseFloat(cs.borderLeftWidth), right: pr.right - parseFloat(cs.borderRightWidth),
        top: pr.top + parseFloat(cs.borderTopWidth), bottom: pr.bottom - parseFloat(cs.borderBottomWidth),
      };
      const inside = r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      if (!inside) break; // 元素自己就被裁了（滚出可视区）→ 这种裁切是应该的
      const dirs = [];
      if (clipX && r.left - RING < box.left - 1) dirs.push('左');
      if (clipX && r.right + RING > box.right + 1) dirs.push('右');
      if (clipY && r.top - RING < box.top - 1) dirs.push('上');
      if (clipY && r.bottom + RING > box.bottom + 1) dirs.push('下');
      if (dirs.length) {
        out.push({ 元素: (el.className || '').split(' ').slice(0, 2).join('.'), 被谁裁: p.className.split(' ')[0], 方向: dirs.join('') });
      }
    }
  }
  return out;
`;


// ── 跑 ──

const problems = [];
const note = (ok, msg) => {
  console.log(`  ${ok ? "✅" : "❌"} ${msg}`);
  if (!ok) problems.push(msg);
};

const run = async (width, height) => {
  console.log(`\n=== ${width}×${height} ===`);
  const page = await connect({ width, height });
  try {
    await page.goto(URL);
    await page.wait(6000); // 开场动画 2.4s + hero 宽图下载

    const g = await page.eval(GEOMETRY);
    const dp = g.dp;
    console.log(`  --dp=${dp}  视口 ${g.viewport.join("×")}`);
    note(g.scroll[0] === width, `内容区没有横向溢出（scrollWidth=${g.scroll[0]}，窗口 ${width}）`);
    note(g.hero.bottom >= g.strip.bottom - 0.5, `hero 盖住卡片条盒底（hero 底 ${g.hero.bottom} ≥ 卡条盒底 ${g.strip.bottom}）`);
    note(Math.abs(g.card.y - 278 * dp) < 2, `聚焦卡顶边落在画板值 278dp=${278 * dp}（实测 ${g.card.y}）`);
    note(Math.abs(g.card.w - 158 * dp) < 2 && Math.abs(g.card.h - 190 * dp) < 2, `聚焦卡 158×190dp（实测 ${g.card.w}×${g.card.h}）`);
    note(Math.abs(g.panel.y - 494 * dp) < 3, `信息面板顶边 494dp=${494 * dp}（实测 ${g.panel.y}）`);
    note(Math.abs(g.chip.y - 174 * dp) < 3, `分组 chip 顶边 174dp=${174 * dp}（实测 ${g.chip.y}）`);
    note(Math.abs(g.navFirst.y - 166 * dp) < 3, `侧栏首行 166dp=${166 * dp}（实测 ${g.navFirst.y}）`);

    // 侧栏相邻两行之间必须容得下焦点环（4dp 外扩 + 3dp 描边 = 7dp）：否则当前页那一行和
    // 焦点停的那一行同时高亮时会连成一坨、环还会压到下一行背景上（用户 2026-10-04 截图）
    const rail = await page.eval(`
      const rows = [...document.querySelectorAll('.rail-items .nav-item')];
      const cur = rows.findIndex((r) => r.classList.contains('is-current'));
      if (cur < 0 || !rows[cur + 1]) return null;
      const a = rows[cur].getBoundingClientRect();
      const b = rows[cur + 1].getBoundingClientRect();
      return { gap: +(b.top - a.bottom).toFixed(2), rowH: +a.height.toFixed(2) };
    `);
    note(
      rail !== null && rail.gap >= 7 * dp,
      `侧栏行间距容得下焦点环（间距 ${rail ? rail.gap : "-"} ≥ 环 ${(7 * dp).toFixed(2)}）`,
    );

    // 聚焦项居中：前几张卡因为条的内容从那儿起、滚不过去，所以往右挪 5 张再看
    for (let i = 0; i < 5; i++) await arrow(page, "ArrowRight");
    await page.wait(600);
    const centered = await page.eval(GEOMETRY);
    note(
      Math.abs(centered.card.centerX - centered.stripCenter) < 2,
      `聚焦卡居中于内容区（卡中心 ${centered.card.centerX} / 内容区中线 ${centered.stripCenter}）`,
    );

    // 聚焦卡的第二行「时长 · 体积」（画板 §3.2）：必须在卡内、且不压住名称
    const facts = await page.eval(`
      const card = document.querySelector('.k1-item.is-current .k1-card');
      const line = card?.querySelector('.k1-card-facts');
      const name = card?.querySelector('.library-name');
      if (!line || !name) return null;
      const c = card.getBoundingClientRect();
      const l = line.getBoundingClientRect();
      const n = name.getBoundingClientRect();
      return { text: (line.textContent || '').trim(), inside: l.bottom <= c.bottom + 0.5 && l.left >= c.left - 0.5, gap: +(l.top - n.bottom).toFixed(1) };
    `);
    note(facts !== null, `聚焦卡有第二行「时长 · 体积」（${facts ? facts.text : "没有 —— 预览数据里应该有"}）`);
    if (facts) note(facts.inside && facts.gap >= -0.5, `第二行在卡内、没压住名称（间隙 ${facts.gap}）`);

    // 信息面板：键值必须成对（dt/dd 各一半），且写出来的都是真字段
    const panel = await page.eval(`
      const dl = document.querySelector('.k1-info-fields');
      if (!dl) return null;
      const dts = [...dl.querySelectorAll('dt')].map((d) => (d.textContent || '').trim());
      const dds = [...dl.querySelectorAll('dd')].map((d) => (d.textContent || '').trim());
      return { dts, dds };
    `);
    note(
      panel !== null && panel.dts.length === panel.dds.length && panel.dts.length > 0,
      `信息面板键值成对（${panel ? panel.dts.join(" / ") : "-"}）`,
    );

    // 焦点域进出（用户 2026-10-04 报的那条）：先退回条上最左边那张，再按左
    for (let i = 0; i < 15; i++) {
      const atFirst = await page.eval(`
        const first = document.querySelector('.k1-strip [data-focusable]');
        return first === document.activeElement;
      `);
      if (atFirst) break;
      await arrow(page, "ArrowLeft");
    }
    await page.wait(300);
    await arrow(page, "ArrowLeft");
    const left = await focused(page);
    note(left.startsWith("shell-rail"), `最左卡按左进侧栏（落在 ${left}）`);
    await arrow(page, "ArrowRight");
    const right = await focused(page);
    note(right.startsWith("library-grid"), `侧栏按右回内容区（落在 ${right}）`);

    const clipped = await page.eval(RING_CLIP);
    const fresh = clipped.filter((c) => !KNOWN_RING_CLIP.some((k) => c.被谁裁.includes(k)));
    note(fresh.length === 0, `焦点环没有被滚动容器裁掉（新问题 ${fresh.length} 处，已知待迁 ${clipped.length - fresh.length} 处）`);
    for (const c of fresh) console.log(`      ❗${JSON.stringify(c)}`);
    for (const c of clipped.filter((x) => !fresh.includes(x))) console.log(`      (已知) ${JSON.stringify(c)}`);

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      const path = join(SHOTS, `probe-${width}x${height}.png`);
      await page.shot(path);
      console.log(`  截图：${path}`);
    }
  } finally {
    await page.close();
  }
};


// 侧栏每个页签都扫一遍「环被裁」（设置抽屉的行在每个页面都在 DOM 里，所以每页都会带上它）
const scanTabs = async () => {
  const [width, height] = SIZES[0];
  const page = await connect({ width, height });
  try {
    await page.goto(URL);
    await page.wait(6000);
    for (const name of ["首页", "游戏库", "软件库", "下载", "文件", "工具箱"]) {
      const ok = await page.eval(`
        const hit = [...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes(${JSON.stringify(name)}));
        if (!hit) return false;
        hit.click();
        await new Promise((r) => setTimeout(r, 900));
        return true;
      `);
      if (!ok) continue;
      const clipped = await page.eval(RING_CLIP);
      const fresh = clipped.filter((c) => !KNOWN_RING_CLIP.some((k) => c.被谁裁.includes(k)));
      const known = clipped.length - fresh.length;
      const summary = clipped.length === 0 ? "环都完整" : `新问题 ${fresh.length} 处 / 已知 ${known} 处`;
      console.log(`  【${name}】${summary}${fresh.length ? " " + fresh.map((c) => `${c.元素}←${c.被谁裁}(${c.方向})`).join("、") : ""}`);
      if (fresh.length) problems.push(`${name} 页有 ${fresh.length} 处焦点环被裁`);
    }
  } finally {
    await page.close();
  }
};

for (const [w, h] of SIZES) await run(w, h);
console.log("\n=== 六个页签的焦点环巡检 ===");
await scanTabs();

console.log(problems.length ? `\n❌ ${problems.length} 项没过：\n  - ${problems.join("\n  - ")}` : "\n✅ 全部通过");
process.exit(problems.length ? 1 : 0);

