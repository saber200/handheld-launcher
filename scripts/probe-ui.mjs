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
 * M3 迁完文件页之后，六个可进入的页签实测都是「环都完整」；这里只剩 LibraryShelf 的旧网格
 * （`.library-grid`，只出现在「添加卡片」那类弹窗里，巡检扫不到）。
 */
const KNOWN_RING_CLIP = ["library-grid"];

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

    // 设置抽屉（画板 K3）：这块 DOM 一直在，只是被 translateX 挪出屏幕 ——
    // 宽度 / 行高 / 步进 / 控件尺寸都和位移无关，所以不用真把它拉开也能对。抽屉必须
    // 排在最上面（z-index 5），量的是它自己的盒子，不是屏幕坐标。
    const k3 = await page.eval(`
      const drawer = document.querySelector('.drawer');
      const rows = [...document.querySelectorAll('.k3-list .k3-row')];
      const sw = document.querySelector('.k3-switch');
      const close = document.querySelector('.k3-close');
      if (!drawer || rows.length < 3 || !sw || !close) return null;
      const box = (el) => { const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), y: +r.y.toFixed(2) }; };
      return {
        dp: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1,
        drawer: box(drawer), rows: rows.length, row: box(rows[0]),
        step: +(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top).toFixed(2),
        sw: box(sw), close: box(close),
        head: box(document.querySelector('.k3-head')),
      };
    `);
    if (!k3) {
      note(false, "设置抽屉是 K3：找不到 .k3-row / .k3-switch / .k3-close");
    } else {
      const d = k3.dp;
      note(Math.abs(k3.drawer.w - 440 * d) < 3, `K3 抽屉宽 440dp=${(440 * d).toFixed(1)}（实测 ${k3.drawer.w}）`);
      note(Math.abs(k3.row.h - 52 * d) < 2.5, `K3 设置行高 52dp（实测 ${k3.row.h}）`);
      note(Math.abs(k3.step - 62 * d) < 2.5, `K3 设置行步进 62dp（实测 ${k3.step}）`);
      note(k3.rows >= 6, `K3 抽屉里 ${k3.rows} 行（语言 / 自启 / FSE / 小组件 / 退出 / 关于…）`);
      note(Math.abs(k3.sw.w - 42 * d) < 2 && Math.abs(k3.sw.h - 24 * d) < 2,
        `K3 开关轨道 42×24（实测 ${k3.sw.w}×${k3.sw.h}）`);
      note(Math.abs(k3.close.w - 34 * d) < 2 && Math.abs(k3.close.h - 34 * d) < 2,
        `K3 关闭按钮 34×34（实测 ${k3.close.w}×${k3.close.h}）`);
    }

    // 呼出设置抽屉：双击 View（和真机同一套手势，viewGesture="double"）。拉出来截一张，
    // 然后点遮罩关掉 —— 不然下面那些「焦点跨域」检查会跑在抽屉这个焦点陷阱里。
    const drawerOpen = await page.eval(`
      const pad = { id: 'probe', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0] };
      pad.buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false }));
      navigator.getGamepads = () => [pad];
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const tap = async () => { pad.buttons[8] = { pressed: true, value: 1, touched: true }; await wait(120); pad.buttons[8] = { pressed: false, value: 0, touched: false }; };
      await tap();
      await wait(150);
      await tap();
      await wait(700);
      return !!document.querySelector('.drawer-root.open');
    `);
    note(drawerOpen, `双击 View 呼出设置抽屉（实测 open=${drawerOpen}）`);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.shot(join(SHOTS, `k3-drawer-${width}x${height}.png`));
    }
    await page.eval(`
      document.querySelector('.drawer-scrim')?.click();
      await new Promise((r) => setTimeout(r, 600));
      navigator.getGamepads = () => [];
      return !document.querySelector('.drawer-root.open');
    `);

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

      // 软件库 = 画板 K2：6 列卡片网格，卡片是「包头行 / 图标区 / 名称 / 底部行」四段。
      // 这些数字全来自改造包 §4.1（152.7×176、包头行 20、图标区 58、名称距图标区 12、
      // 底部行距下缘 16）与画板 K2 的实测（第一行顶 134、间隙 16）。改卡片就别改期望值，
      // 改了要在这里说明为什么。
      if (name === "软件库") {
        const k2 = await page.eval(`
          const grid = document.querySelector('.k2-grid');
          const cards = [...document.querySelectorAll('.k2-card')];
          const bar = document.querySelector('.k2-bar');
          if (!grid || cards.length === 0) return null;
          const gs = getComputedStyle(grid);
          const c = cards[0].getBoundingClientRect();
          const second = cards[1]?.getBoundingClientRect();
          const pick = (sel) => cards[0].querySelector(sel)?.getBoundingClientRect() ?? null;
          const head = pick('.k2-card-head');
          const icon = pick('.k2-icon');
          const nameEl = pick('.k2-card-name');
          const foot = pick('.k2-card-foot');
          const below = cards[6]?.getBoundingClientRect() ?? null;
          const rel = (r) => (r ? +(r.top - c.top).toFixed(2) : null);
          return {
            cols: gs.gridTemplateColumns.split(' ').length,
            colGap: parseFloat(gs.columnGap) || 0,
            cardW: +c.width.toFixed(2),
            cardH: +c.height.toFixed(2),
            cardY: +c.top.toFixed(2),
            rowGap: below ? +(below.top - c.bottom).toFixed(2) : null,
            headTop: rel(head),
            headH: head ? +head.height.toFixed(2) : null,
            iconTop: rel(icon),
            iconH: icon ? +icon.height.toFixed(2) : null,
            nameTop: rel(nameEl),
            footGap: foot ? +(c.bottom - foot.bottom).toFixed(2) : null,
            barH: bar ? +bar.getBoundingClientRect().height.toFixed(2) : 0,
            title: (document.querySelector('.k2-head h2')?.textContent || '').trim(),
            dp: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1,
          };
        `);
        const d = k2 ? k2.dp : 1;
        if (!k2) {
          note(false, "软件库是 K2（6 列卡片网格）：找不到 .k2-grid / .k2-card");
        } else {
          note(k2.cols === 6, `K2 网格 6 列（实测 ${k2.cols} 列）`);
          note(Math.abs(k2.cardW - 152.7 * d) < 3, `K2 卡片宽 152.7dp=${(152.7 * d).toFixed(1)}（实测 ${k2.cardW}）`);
          note(Math.abs(k2.cardH - 176 * d) < 3, `K2 卡片高 176dp=${(176 * d).toFixed(1)}（实测 ${k2.cardH}）`);
          note(Math.abs(k2.cardY - 134 * d) < 5, `K2 第一行顶 134dp=${(134 * d).toFixed(1)}（实测 ${k2.cardY}）`);
          note(Math.abs(k2.colGap - 16 * d) < 2 && Math.abs((k2.rowGap ?? 0) - 16 * d) < 2,
            `K2 卡片间隙 16dp（列 ${k2.colGap} / 行 ${k2.rowGap}）`);
          note(Math.abs(k2.headTop - 16 * d) < 2 && Math.abs(k2.headH - 20 * d) < 2,
            `K2 包头行：距卡顶 16dp、高 20dp（实测 ${k2.headTop} / ${k2.headH}）`);
          note(Math.abs(k2.iconTop - 44 * d) < 3 && Math.abs(k2.iconH - 58 * d) < 2,
            `K2 图标区：距卡顶 44dp、高 58dp（实测 ${k2.iconTop} / ${k2.iconH}）`);
          note(k2.nameTop !== null && Math.abs(k2.nameTop - 114 * d) < 4,
            `K2 名称距卡顶 114dp（实测 ${k2.nameTop}）`);
          note(Math.abs(k2.footGap - 16 * d) < 2, `K2 底部行距卡下缘 16dp（实测 ${k2.footGap}）`);
          note(Math.abs(k2.barH - 48 * d) < 3, `K2 底部操作条高 48dp=${(48 * d).toFixed(1)}（实测 ${k2.barH}）`);
          note(k2.title.length > 0, `K2 头部有标题（${k2.title}）`);
        }
      }
      // ── 左右键跨焦点域（用户 2026-10-04 报过「从内容区按左进不了侧栏 / 从侧栏按右出不来」）：
      //    逐页把**每个**可聚焦元素都试一遍 —— 一直按左（至多 40 步）必须能进侧栏；
      //    侧栏每一行一直按右必须能出到内容区。这比单测「最左那张卡」严得多：
      //    M3 之前只在游戏库那一种布局上验过，软件库 / 文件页 / 工具箱是这次才扫的。
      const navAll = await page.eval(`
        const mod = await import('/src/hooks/useGamepadNav.ts');
        const zoneOf = (el) => el.closest('[data-focus-zone]')?.getAttribute('data-focus-zone') ?? '-';
        const isRail = (el) => !!el.closest('.nav-rail');
        const vis = () => [...document.querySelectorAll('[data-focusable]')].filter((el) => el.offsetParent !== null);
        const walk = (dir, ok) => {
          let prev = null;
          let step = 0;
          while (step++ < 40) {
            mod.moveDirectionalFocus(dir, 0);
            const now = document.activeElement;
            if (ok(now)) return step;
            if (now === prev) break; // 原地不动 = 卡死
            prev = now;
          }
          return 0;
        };
        const stuck = [];
        let n = 0;
        for (const el of vis()) {
          if (isRail(el) || el.closest('.drawer-root')) continue;
          n++;
          el.focus();
          if (document.activeElement !== el) continue;
          if (!walk(-1, isRail)) stuck.push(zoneOf(el) + ':' + (el.className || '').split(' ')[0] + '|' + (el.textContent || '').trim().slice(0, 6));
        }
        const railStuck = [];
        for (const item of [...document.querySelectorAll('.nav-item')]) {
          if (!item.offsetParent) continue;
          item.focus();
          if (!walk(1, (el) => !isRail(el))) railStuck.push((item.textContent || '').trim().slice(0, 4));
        }
        return { n, stuck, railStuck };
      `);
      note(navAll.stuck.length === 0,
        `${name}：内容区 ${navAll.n} 个可聚焦元素一直按左都能进侧栏${navAll.stuck.length ? "（卡住的：" + navAll.stuck.slice(0, 4).join("、") + "）" : ""}`);
      // 首页 / 下载还是「排期中」占位页，内容区一个可聚焦元素都没有，按右没地方去 —— 这条不报错
      if (navAll.n > 0) {
        note(navAll.railStuck.length === 0,
          `${name}：侧栏每行一直按右都能出到内容区${navAll.railStuck.length ? "（出不去的：" + navAll.railStuck.join("、") + "）" : ""}`);
      }

      if (name === "文件") {
        await page.eval(`
          const row = document.querySelector('.k7-row');
          if (row) row.click();
          await new Promise((r) => setTimeout(r, 700));
          return true;
        `);
        const k7 = await page.eval(`
          const rect = (el) => { const r = el.getBoundingClientRect();
            return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), right: +r.right.toFixed(2) }; };
          const box = (sel) => { const el = document.querySelector(sel); return el ? rect(el) : null; };
          const rows = [...document.querySelectorAll('.k7-row')];
          const places = [...document.querySelectorAll('.k7-place')];
          const head = document.querySelector('.k7-table-head');
          const bar = document.querySelector('.k7-bar');
          const left = (el) => (el ? +el.getBoundingClientRect().left.toFixed(2) : null);
          return {
            dp: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1,
            crumb: box('.k7-crumbs .k7-crumb'),
            crumbs: document.querySelectorAll('.k7-crumbs .k7-crumb').length,
            places: box('.k7-places'),
            place: box('.k7-place'),
            placeStep: places.length > 1 ? +(places[1].getBoundingClientRect().top - places[0].getBoundingClientRect().top).toFixed(2) : null,
            head: box('.k7-table-head'),
            headX: head ? [...head.querySelectorAll('span')].map(left) : [],
            row: rows[0] ? rect(rows[0]) : null,
            rowStep: rows.length > 1 ? +(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top).toFixed(2) : null,
            iconX: left(document.querySelector('.k7-row-icon')),
            nameX: left(document.querySelector('.k7-row-name')),
            sizeX: left(document.querySelector('.k7-row-size')),
            timeX: left(document.querySelector('.k7-row-time')),
            bar: bar ? rect(bar) : null,
            chip: box('.k7-chip'),
            search: box('.k7-search'),
            sort: box('.k7-sort'),
            rows2: rows.length,
          };
        `);
        const d = k7 ? k7.dp : 1;
        if (!k7 || !k7.row || !k7.bar) {
          note(false, "文件页是 K7：找不到 .k7-row / .k7-bar");
        } else {
          note(Math.abs(k7.crumb.y - 52 * d) < 2.5 && Math.abs(k7.crumb.h - 30 * d) < 1.5,
            `K7 面包屑 chip：顶边 52dp、高 30dp（实测 ${k7.crumb.y} / ${k7.crumb.h}）`);
          note(k7.crumbs >= 2, `K7 面包屑有分隔的层级（${k7.crumbs} 片）`);
          note(Math.abs(k7.places.x - 260 * d) < 1.5 && Math.abs(k7.places.w - 200 * d) < 1.5 && Math.abs(k7.places.y - 98 * d) < 2.5,
            `K7 位置栏 200dp 起于 260 / 98（实测 ${k7.places.x} / ${k7.places.y} / 宽 ${k7.places.w}）`);
          note(k7.placeStep !== null && Math.abs(k7.placeStep - 32 * d) < 1.5,
            `K7 位置行步进 32dp（实测 ${k7.placeStep}）`);
          note(Math.abs(k7.head.y - 98 * d) < 2.5 && Math.abs(k7.head.h - 34 * d) < 2,
            `K7 表头顶边 98dp、高 34dp（实测 ${k7.head.y} / ${k7.head.h}）`);
          note(k7.headX.length === 3 && Math.abs(k7.headX[1] - 872 * d) < 4 && Math.abs(k7.headX[2] - 982 * d) < 4,
            `K7 表头三列落在 492 / 872 / 982dp（实测 ${k7.headX.map((v) => Math.round(v)).join(" / ")}）`);
          note(Math.abs(k7.row.y - 146 * d) < 3 && Math.abs(k7.row.h - 39 * d) < 2,
            `K7 首行顶边 146dp、行盒 39dp（实测 ${k7.row.y} / ${k7.row.h}）`);
          note(k7.rowStep !== null && Math.abs(k7.rowStep - 46 * d) < 1.5,
            `K7 行步进 46dp（实测 ${k7.rowStep}）`);
          note(Math.abs(k7.row.x - 476 * d) < 1.5 && Math.abs(k7.row.right - 1256 * d) < 1.5,
            `K7 行盒横跨 476..1256（实测 ${k7.row.x}..${k7.row.right}）`);
          note(Math.abs(k7.iconX - 489 * d) < 3 && Math.abs(k7.nameX - 521.5 * d) < 3.5,
            `K7 行图标 489dp / 名称 521.5dp（实测 ${k7.iconX} / ${k7.nameX}）`);
          note(Math.abs(k7.sizeX - 872 * d) < 4 && Math.abs(k7.timeX - 982 * d) < 4,
            `K7 行内大小 872dp / 时间 982dp（实测 ${k7.sizeX} / ${k7.timeX}）`);
          note(Math.abs(k7.bar.y - 610 * d) < 3 && Math.abs(k7.bar.h - 46 * d) < 1.5,
            `K7 底部操作条顶边 610dp、高 46dp（实测 ${k7.bar.y} / ${k7.bar.h}）`);
          note(Math.abs(k7.bar.x - 476 * d) < 1.5 && Math.abs(k7.bar.right - 1256 * d) < 1.5,
            `K7 操作条宽度跟着文件栏走 476..1256（实测 ${k7.bar.x}..${k7.bar.right}）`);
          note(k7.chip && Math.abs(k7.chip.h - 28 * d) < 1.5, `K7 操作 chip 高 28dp（实测 ${k7.chip ? k7.chip.h : "-"}）`);
          note(Math.abs(k7.search.w - 104 * d) < 2 && Math.abs(k7.sort.w - 96 * d) < 2,
            `K7 搜索 104dp / 排序 96dp（实测 ${k7.search.w} / ${k7.sort.w}）`);
          note(Math.abs(k7.sort.right - 1256 * d) < 2,
            `K7 排序按钮贴右侧安全边 1256dp（实测 ${k7.sort.right}）`);

          // 交互冒烟：排序展开行、选中项驱动底部操作条（这两条是 K7 新加的联动，
          // 只靠几何量不出来 —— 按钮在那儿但没接上，几何照样是绿的）。
          const inter = await page.eval(`
            const click = (sel) => { const el = document.querySelector(sel); if (el) el.click(); return !!el; };
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const out = {};
            click('.k7-sort');
            await wait(250);
            out.sortKeys = document.querySelectorAll('.k7-sort-key').length;
            click('.k7-sort');
            await wait(250);
            out.sortClosed = document.querySelectorAll('.k7-sort-key').length;
            const row = document.querySelector('.k7-row');
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
            await wait(250);
            out.picked = document.querySelectorAll('.k7-row.is-picked').length;
            out.note = (document.querySelector('.k7-bar-note')?.textContent || '').trim().slice(0, 10);
            const chips = [...document.querySelectorAll('.k7-chip')];
            out.chips = chips.length;
            out.copyOn = chips[0] ? !chips[0].disabled : false;
            out.renameOn = chips[3] ? !chips[3].disabled : false;
            return out;
          `);
          note(inter.sortKeys === 4 && inter.sortClosed === 0,
            `K7「排序」展开 4 个键、再点收起（${inter.sortKeys} → ${inter.sortClosed}）`);
          note(inter.chips === 8, `K7 底部操作条 8 个 chip（实测 ${inter.chips}）`);
          note(inter.picked === 1 && inter.copyOn && inter.renameOn && inter.note.includes("已选"),
            `K7 选中一项后操作条跟着变（选中 ${inter.picked} 项 / 复制${inter.copyOn ? "亮" : "灰"} / 提示「${inter.note}」）`);
        }
      }

      // 工具箱 = 画板 K4：主卡 616×196 + 右侧两张 90 + 底部两张 490×157。
      // 期望值来自画板实测（2560×1440 的 PNG 按 2 除回 dp）。
      if (name === "工具箱") {
        const k4 = await page.eval(`
          const rect = (el) => { const r = el.getBoundingClientRect();
            return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), right: +r.right.toFixed(2) }; };
          const box = (sel) => { const el = document.querySelector(sel); return el ? rect(el) : null; };
          const cards = [...document.querySelectorAll('.k4-body .k4-card')];
          const stat = document.querySelector('.k4-stat');
          const stats = [...document.querySelectorAll('.k4-stat')];
          return {
            dp: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1,
            head: box('.k4-head h2'),
            self: box('.k4-selfcheck'),
            main: box('.k4-main .k4-card'),
            side: [...document.querySelectorAll('.k4-side .k4-card')].map(rect),
            bottom: [...document.querySelectorAll('.k4-pair .k4-card')].map(rect),
            primary: box('.k4-primary'),
            stats: stats.length,
            statW: stat ? +stat.getBoundingClientRect().width.toFixed(2) : null,
            cards: cards.length,
          };
        `);
        const d = k4 ? k4.dp : 1;
        if (!k4 || !k4.main || k4.side.length !== 2 || k4.bottom.length !== 2) {
          note(false, "工具箱是 K4：找不到主卡 / 右侧两卡 / 底部两卡");
        } else {
          note(Math.abs(k4.main.x - 260 * d) < 2 && Math.abs(k4.main.right - 876 * d) < 2,
            `K4 主卡横跨 260..876（实测 ${k4.main.x}..${k4.main.right}）`);
          note(Math.abs(k4.main.y - 98 * d) < 3 && Math.abs(k4.main.h - 196 * d) < 3,
            `K4 主卡顶边 98dp、高 196dp（实测 ${k4.main.y} / ${k4.main.h}）`);
          note(k4.side.every((c) => Math.abs(c.x - 892 * d) < 2 && Math.abs(c.right - 1256 * d) < 2),
            `K4 右侧两卡 892..1256（实测 ${k4.side.map((c) => Math.round(c.x) + ".." + Math.round(c.right)).join(" / ")}）`);
          note(k4.side.every((c) => Math.abs(c.h - 90 * d) < 4),
            `K4 右侧两卡各 90dp 高（实测 ${k4.side.map((c) => Math.round(c.h)).join(" / ")}）`);
          note(k4.side[0].y > k4.main.y - 1 && k4.side[1].y > k4.side[0].y + 60 * d,
            `K4 右侧两卡上下排（${Math.round(k4.side[0].y)} → ${Math.round(k4.side[1].y)}）`);
          note(k4.bottom.every((c) => Math.abs(c.h - 157 * d) < 4) && Math.abs(k4.bottom[0].y - 310.5 * d) < 4,
            `K4 底部两卡顶边 310.5dp、高 157dp（实测 ${k4.bottom[0].y} / ${k4.bottom.map((c) => Math.round(c.h)).join(" / ")}）`);
          note(
            Math.abs(k4.bottom[0].w - 490 * d) < 3 && Math.abs(k4.bottom[1].w - 490 * d) < 3,
            `K4 底部两卡各 490dp 宽（实测 ${k4.bottom.map((c) => Math.round(c.w)).join(" / ")}）`,
          );
          note(Math.abs(k4.primary.w - 132 * d) < 2 && Math.abs(k4.primary.h - 40 * d) < 2,
            `K4 主卡按钮 132×40（实测 ${k4.primary.w}×${k4.primary.h}）`);
          note(k4.stats === 3 && Math.abs(k4.statW - 118 * d) < 3,
            `K4 主卡状态格 118dp 宽 × ${k4.stats} 格（实测 ${k4.statW}）`);
          note(Math.abs(k4.self.h - 32 * d) < 2 && Math.abs(k4.self.right - 1256 * d) < 2,
            `K4 自检按钮高 32dp、贴右安全边（实测 ${k4.self.h} / ${k4.self.right}）`);
          note(k4.head && String(k4.head.y).length > 0, `K4 头部有标题（实测顶边 ${k4.head ? k4.head.y : "-"}）`);
        }
      }

      if (SHOTS) {
        const p = join(SHOTS, `tab-${name}-${width}x${height}.png`);
        await page.shot(p);
      }
    }
  } finally {
    await page.close();
  }
};

/**
 * 英文一遍（改造包 §16 的验收项「中英双语切换后无截断、无溢出」）：
 * 把 localStorage 里的语言设成 en、刷新，再把六个页签走一遍 —— 查两件事：
 *   ① 整页没有横向溢出（scrollWidth > 视口宽）；
 *   ② 交互控件上的字没被截（scrollWidth > clientWidth，容 2px 的亚像素零头）。
 * 只查控件，不查正文：文件名那一列本来就该省略号收尾，那是设计不是 bug。
 */
const englishPass = async () => {
  for (const [width, height] of SIZES) {
    console.log(`\n=== 英文一遍 ${width}×${height} ===`);
    const page = await connect({ width, height });
    try {
      await page.goto(URL);
      await page.eval(`
        localStorage.setItem('handheld-launcher.locale', 'en');
        return true;
      `);
      await page.goto(URL);
      await page.wait(5000);
      for (const [index, name] of ["首页", "游戏库", "软件库", "下载", "文件", "工具箱"].entries()) {
        // 英文界面上侧栏文字是 Home / Library…，所以按**位置**点（顺序固定）而不是按文字找
        const ok = await page.eval(`
          const items = [...document.querySelectorAll('.nav-item')];
          const hit = items[${index}];
          if (!hit) return false;
          hit.click();
          await new Promise((r) => setTimeout(r, 800));
          return true;
        `);
        if (!ok) continue;
        const en = await page.eval(`
          const width = innerWidth;
          const overflow = document.documentElement.scrollWidth > width + 1;
          const sel = '.nav-item, .k7-tool, .k7-search, .k7-sort, .k7-chip, .k7-crumb, .k7-place, .k2-btn, .k1-btn, .hint-pair, .k4-selfcheck, .k4-card-action, .k4-primary, .k4-row-item, .library-tool';
          const clipped = [...document.querySelectorAll(sel)]
            .filter((el) => el.offsetParent !== null && el.scrollWidth > el.clientWidth + 2)
            .map((el) => (el.className || '').split(' ')[0] + '|' + (el.textContent || '').trim().slice(0, 16));
          return { overflow, clipped: clipped.slice(0, 5), n: clipped.length, lang: document.documentElement.lang };
        `);
        const label = `${name}（英文 lang=${en.lang}）`;
        note(!en.overflow, `${label}：整页没有横向溢出`);
        note(en.n === 0, `${label}：控件上的字都没被截${en.n ? "（" + en.clipped.join("、") + "）" : ""}`);
        if (SHOTS) {
          const p = join(SHOTS, `en-${name}-${width}x${height}.png`);
          await page.shot(p);
        }
      }
      await page.eval(`
        localStorage.setItem('handheld-launcher.locale', 'zh');
        return true;
      `);
    } finally {
      await page.close();
    }
  }
};

for (const [w, h] of SIZES) await run(w, h);
console.log("\n=== 六个页签的焦点环巡检 ===");
await scanTabs();
await englishPass();

console.log(problems.length ? `\n❌ ${problems.length} 项没过：\n  - ${problems.join("\n  - ")}` : "\n✅ 全部通过");
process.exit(problems.length ? 1 : 0);

