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
      // 2026-10-11：Chrome 111+ 默认拒掉非 Chrome 自己发起的 DevTools WebSocket 连接，
      // 少了这个开关，脚本会**卡在第一条 CDP 命令上**（现象是「Chrome 没起来」，其实起来了）。
      "--remote-allow-origins=*",
      // 在容器/沙箱里跑时 Chrome 自己的沙箱起不来（Failed to initialize sandbox），会随机启动失败；
      // 这个工具只在本机开个无头浏览器看界面，关掉它自己的沙箱没有额外风险。
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-crashpad",
      "--disable-breakpad",
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
  /** 持续监听某个 CDP 事件（`once` 只收一次，拦截请求这种要收一串）。 */
  const on = (method, handler) => {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === method) handler(msg.params);
    });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  return {
    send,
    on,
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
  // 分区页签条（2026-10-11 从左侧栏搬进顶栏，见 shell.css 顶部说明）
  const nav = document.querySelector('.nav-items');
  const navBox = nav ? nav.getBoundingClientRect() : null;
  const tabs = [...document.querySelectorAll('.nav-item')];
  const gapOf = (a, b) => +(b.getBoundingClientRect().left - a.getBoundingClientRect().right).toFixed(2);
  return {
    dp: +(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1),
    viewport: [innerWidth, innerHeight],
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    hero: box('.k1-hero'), strip: box('.k1-strip'), card: box('.k1-item.is-current'),
    panel: box('.k1-panel'), chip: box('.group-chip'),
    stripCenter: strip ? +(strip.getBoundingClientRect().x + strip.clientWidth / 2).toFixed(2) : null,
    nav: box('.nav-items'),
    navFocusables: nav ? nav.querySelectorAll('[data-focusable]').length : -1,
    navTabs: tabs.length,
    navClipped: tabs.filter((t) => t.scrollWidth > t.clientWidth + 2).length,
    navMinGap: tabs.length > 1 ? Math.min(...tabs.slice(1).map((t, i) => gapOf(tabs[i], t))) : null,
    // 页签必须都待在条盒里（条是 flex:1 + justify-content:center，装不下会溢出到时钟/电量上）
    navInside: navBox
      ? tabs.every((t) => {
          const r = t.getBoundingClientRect();
          return r.left >= navBox.left - 0.5 && r.right <= navBox.right + 0.5;
        })
      : false,
    clock: box('.top-clock'), date: box('.top-date'), battery: box('.top-chip'),
    hintBar: box('.shell-hint'), storage: box('.storage-inline'), hints: box('.shell-hints'),
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

    /*
     * 分区页签条（2026-10-11：菜单从左侧栏搬进顶栏，并且**整个退出焦点系统**）。
     * 四条断言对应「换页只有 LB/RB 与 Q/E」这唯一一条规矩：
     *   ① 里面一个 [data-focusable] 都没有（有的话它又成了焦点域，方向键迟早跑回去）；
     *   ② 9 个页签都在条盒里、字没被截（中英双语都要成立，英文在 englishPass 里再走一遍）；
     *   ③ 页签之间留了间距（相邻盒子不许贴在一起）；
     *   ④ 焦点掉出池子（下面单独测）也落回内容区。
     */
    note(g.navFocusables === 0, `页签条里 0 个可聚焦元素（实测 ${g.navFocusables}）`);
    note(g.navTabs === 9, `页签条 9 项（7 个可进 + 商店 / 社区两个锁定项，实测 ${g.navTabs}）`);
    note(g.navInside && g.navClipped === 0, `页签都在条盒里、字没被截（越界=${!g.navInside} 截断=${g.navClipped}）`);
    note(g.navMinGap !== null && g.navMinGap >= 2 * dp, `页签之间有间距（最小 ${g.navMinGap} ≥ ${(2 * dp).toFixed(2)}）`);
    note(
      g.nav.x >= g.date.x + g.date.w - 0.5 && g.nav.x + g.nav.w <= (g.battery ? g.battery.x : g.viewport[0] - 24 * dp) + 0.5,
      `页签条夹在日期与电量之间（条 ${g.nav.x}..${(g.nav.x + g.nav.w).toFixed(1)}，日期右缘 ${(g.date.x + g.date.w).toFixed(1)}，电量左缘 ${g.battery ? g.battery.x : "-"}）`,
    );
    note(
      Math.abs(g.hintBar.y + g.hintBar.h - g.viewport[1]) < 1.5,
      `底部状态条贴住屏幕下沿（底 ${(g.hintBar.y + g.hintBar.h).toFixed(1)} / 视口高 ${g.viewport[1]}）`,
    );
    /*
     * 0.1.78：底部那条按键提示（`A 启动/安装 · B 卡片菜单 · LT/RT 切分组 · LB/RB 切分区 ·
     * ≡ 设置抽屉`）按用户要求整个去掉了 —— 状态条现在只剩左边的存储读数。
     * 所以这条断言从「提示起于存储右边」改成「**提示整块不存在**，而且存储读数还在安全边内」。
     */
    note(
      g.hints === null && g.storage && g.storage.x >= 24 * dp - 0.5,
      `状态条只剩存储读数、按键提示已去掉（存储起于 ${g.storage ? g.storage.x : "-"}，提示块 ${g.hints ? "还在" : "已去掉"}）`,
    );

    /*
     * 逐盘容量（用户 2026-10-12：「除了显示总容量，也分盘符显示下容量吧，这样比较一目了然」）。
     *
     * 数字来自 `src/data/previewDrives.ts`（浏览器预览的假盘表，形状与后端 `DriveSpace` 一致：
     * C: 476 GB 用了 356、D: 954 GB 用了 640）。这里量三件事：
     *   ① 有几格就等于「参与合计的盘」有几块（合计与逐盘不能对不上）；
     *   ② 每格盘符形如 `C:`，而且数字确实是那一块盘的（拿假盘表的值对一遍）；
     *   ③ 整条状态条**不溢出屏幕**（掌机 1280 宽时最容易顶出去）。
     */
    const brk = await page.eval(`
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
      };
      const preview = await import('/src/data/previewDrives.ts');
      const rows = [...document.querySelectorAll('.storage-drive')].map((el) => ({
        mount: (el.querySelector('b')?.textContent || '').trim(),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        title: el.getAttribute('title') || '',
      }));
      return {
        rows,
        fixed: preview.PREVIEW_DRIVES.filter((d) => d.kind === 'fixed').map((d) => ({
          mount: d.mount,
          usedGb: Math.round((d.totalBytes - d.freeBytes) / 1024 ** 3),
          totalGb: Math.round(d.totalBytes / 1024 ** 3),
        })),
        bar: box(document.querySelector('.shell-hint')),
        inline: box(document.querySelector('.storage-inline')),
        viewport: [window.innerWidth, window.innerHeight],
      };
    `);
    note(
      brk.rows.length === brk.fixed.length && brk.rows.length > 1,
      `状态条：逐盘容量 ${brk.rows.length} 格 = 参与合计的盘 ${brk.fixed.length} 块（${brk.rows.map((r) => r.mount).join("、")}）`,
    );
    const driveOk = brk.fixed.every((want) => {
      const got = brk.rows.find((row) => row.mount === want.mount);
      if (!got) return false;
      // 数字可能写成「356 GB」或「356.0 GB」，这里只认数字本身。
      return got.text.includes(String(want.usedGb)) && got.text.includes(String(want.totalGb));
    });
    note(
      driveOk && brk.rows.every((row) => /^[A-Z]:$/.test(row.mount) && row.title.length > 0),
      `状态条：每格写的是那块盘自己的数字与盘符（${brk.rows.map((r) => r.text).join(" ｜ ")}）`,
    );
    note(
      brk.bar !== null && brk.inline !== null && brk.inline.x + brk.inline.w <= brk.viewport[0],
      `状态条不溢出屏幕（存储读数右缘 ${brk.inline ? (brk.inline.x + brk.inline.w).toFixed(1) : "-"} ≤ 视口宽 ${brk.viewport[0]}）`,
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
      // 量的是**文字那层**：外层 .library-name 现在是铺阴影的盒子（贴到卡片下沿），
      // 拿它跟 facts 比会永远「压住」（2026-10-12 拆两层时顺手改的）。
      const name = card?.querySelector('.library-name-text');
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

    /*
     * OTA 那一行（用户 2026-10-12：「能不能做 ota 升级，每次都要重新下载，好麻烦」）。
     * 预览里查不了（不联网、也没有 updater 后端），所以这里只钉两件事：
     * ① 抽屉里确实有「版本与更新」这一行，而且那颗按钮**可聚焦**（手柄走得到）；
     * ② 按钮文案与状态对得上 —— 预览里是「检查更新」，点一下会得到一句实话而不是假装在查。
     */
    const ota = await page.eval(`
      const rows = [...document.querySelectorAll('.k3-list .k3-row')];
      const row = rows.find((r) => /版本与更新|Version & updates/.test(r.textContent || ''));
      if (!row) return null;
      const btn = row.querySelector('button');
      return {
        hint: (row.querySelector('small')?.textContent || '').trim(),
        label: (btn?.textContent || '').trim(),
        focusable: btn?.hasAttribute('data-focusable') ?? false,
      };
    `);
    /*
     * 「开机时静默启动 Steam」那一行（用户 2026-10-12：「把开机时拉起 steam 下面的那些提示去掉，
     * 只留：开机时静默启动 steam」）：**标题就是这一行全部的字**，不许再有 `<small>` 提示。
     */
    const steamRow = await page.eval(`
      const row = [...document.querySelectorAll('.k3-list .k3-row')].find((r) =>
        /静默启动 Steam|Start Steam silently/.test(r.textContent || ''),
      );
      if (!row) return null;
      return {
        strong: (row.querySelector('strong')?.textContent || '').trim(),
        small: (row.querySelector('small')?.textContent || '').trim(),
        hasSwitch: !!row.querySelector('.k3-switch'),
      };
    `);
    /*
     * 「手柄死区」那一行**整行去掉了**（用户 2026-10-12：「手柄死区的调整也给去掉 不要了」）。
     * 死区本身还在用（输入层读的是 preferences 里的默认值），去掉的只是"让用户调"的那一行。
     */
    const deadRow = await page.eval(`
      const rows = [...document.querySelectorAll('.k3-list .k3-row')];
      return {
        hasDeadzone: rows.some((r) => /死区|deadzone/i.test(r.textContent || '')),
        hasScale: rows.some((r) => /界面缩放|Interface scale|UI scale/i.test(r.textContent || '')),
      };
    `);
    /*
     * 「打开系统全屏体验设置」那一行也去掉了（用户 2026-10-12：「只保留登记，用户自己去操作
     * windows 设置」）—— 「登记」（FSE 稀疏包）那一行**保留**。
     */
    const fseRows = await page.eval(`
      const rows = [...document.querySelectorAll('.k3-list .k3-row')];
      const text = rows.map((r) => (r.textContent || '').trim());
      return {
        hasOpenSettings: text.some((t) => /打开系统全屏体验设置|Open.*fullscreen experience/i.test(t)),
        hasRegister: text.some((t) => /登记|Register/i.test(t)),
      };
    `);
    /*
     * 设置抽屉底部：**只留标语**，那句按键提示（`A 确认 · B 关闭抽屉 · …`）也去掉了
     * （用户 2026-10-12：「专为掌机而生下面那一行小操作提示也都去掉没必要，只保留标语即可」）。
     */
    const foot = await page.eval(`
      const line = document.querySelector('.k3-foot .about-line');
      const keys = document.querySelector('.k3-foot .k3-keys');
      return { tagline: (line?.textContent || '').trim(), hasKeys: !!keys };
    `);
    note(
      foot.tagline.length > 0 && !foot.hasKeys,
      `设置抽屉底部只有标语「${foot.tagline}」，按键提示块已去掉（还在=${foot.hasKeys}）`,
    );

    note(
      !fseRows.hasOpenSettings && fseRows.hasRegister,
      `设置抽屉：「打开系统全屏体验设置」已去掉（还在=${fseRows.hasOpenSettings}），「登记」保留=${fseRows.hasRegister}`,
    );

    note(
      !deadRow.hasDeadzone && deadRow.hasScale,
      `设置抽屉：死区那一行已去掉（还在=${deadRow.hasDeadzone}），旁边的「界面缩放」还在=${deadRow.hasScale}`,
    );

    note(
      !!steamRow && steamRow.small === "" && /静默启动 Steam/.test(steamRow.strong) && steamRow.hasSwitch,
      steamRow
        ? `设置抽屉：「${steamRow.strong}」这一行没有提示小字（small=「${steamRow.small}」，开关在=${steamRow.hasSwitch}）`
        : "设置抽屉：找不到「开机时静默启动 Steam」那一行",
    );

    note(
      !!ota && ota.focusable && /检查更新|Check for updates/.test(ota.label),
      ota
        ? `设置抽屉：有「版本与更新」一行，按钮可聚焦（「${ota.label}」，说明「${ota.hint}」）`
        : "设置抽屉：找不到「版本与更新」那一行",
    );

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

    /*
     * 焦点规矩（用户 2026-10-11 真机反馈的最终版）：**菜单是顶栏里的页签条，整条不可聚焦** ——
     * 换页只有手柄 LB/RB、键盘 Q/E 两条路，触摸屏点一下也换页但**不许把 DOM 焦点留在页签上**。
     * 方向键永远只在内容区里走；焦点掉了（按钮变灰 / 被卸载 / 手指点了空白处）也只许落回内容区。
     *
     * 这一段的四条断言就是这几句话，别再改回「按 B 回菜单 / 侧栏按右出内容区」那套
     * —— 那套是 0.1.71 的，已经连同可聚焦的侧栏一起被用户否掉。
     */
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
    note(!left.startsWith("shell-tabs"), `列表最左边按左**留在内容区**（落在 ${left}）`);

    // 点当前页签（手柄上这一下是 LB/RB 之外的补充：触摸屏）→ 焦点落进内容区
    const landed = await page.eval(`
      const tab = document.querySelector('.nav-item[aria-selected="true"]');
      if (!tab) return '-';
      tab.click();
      await new Promise((r) => setTimeout(r, 1000));
      const a = document.activeElement;
      const z = a.closest('[data-focus-zone]');
      return (z ? z.getAttribute('data-focus-zone') : '-') + ' | ' + (a.className || '').split(' ')[0];
    `);
    note(!landed.startsWith("shell-tabs") && landed !== "-", `点当前页签落进内容区（落在 ${landed}）`);

    // 真鼠标点页签（走 CDP 的真事件，合成事件没有默认行为）：换页 + 焦点**不留在页签上**
    // —— 页签的 onPointerDown 里 preventDefault 就是为了这个（触摸屏点一下要能换页，
    // 但焦点一旦被页签拿走，下一次方向键就得重新找落点）。
    const tabBox = await page.eval(`
      const tabs = [...document.querySelectorAll('.nav-item')];
      const tab = tabs.find((t) => t.getAttribute('aria-selected') !== 'true' && !t.classList.contains('is-locked'));
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (tab.textContent || '').trim() };
    `);
    if (!tabBox) {
      note(false, "页签条里找不到「当前页之外的可进入页签」");
    } else {
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tabBox.x, y: tabBox.y, button: "left", clickCount: 1 });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tabBox.x, y: tabBox.y, button: "left", clickCount: 1 });
      await page.wait(900);
      const clicked = await page.eval(`
        const a = document.activeElement;
        const z = a.closest?.('[data-focus-zone]');
        return { onTab: !!a.closest?.('.nav-items'), where: (z ? z.getAttribute('data-focus-zone') : '-') + ' | ' + (a.className || '').split(' ')[0] };
      `);
      note(!clicked.onTab, `鼠标点页签「${tabBox.label}」之后焦点不在页签条上（落在 ${clicked.where}）`);
    }

    // 焦点掉出池子（模拟：按钮按下去就变灰 / 宿主元素被卸载 / 手指点了空白处）→ 方向键把焦点
    // 送回**内容区**。这里以前是「落到池子第一项」，而池子按 DOM 排序、第一项永远是侧栏 ——
    // 用户原话「从落地页通过方向键移动到 menu 上」说的就是它（真机 + 调用栈都验过）。
    const recovered = await page.eval(`
      const mod = await import('/src/hooks/useGamepadNav.ts');
      const out = [];
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        document.activeElement?.blur?.();
        mod.moveDirectionalFocus(dx, dy);
        const a = document.activeElement;
        const where = a === document.body ? 'BODY' : (a.closest('.nav-items') ? '页签条' : (a.closest('.tab-panel') ? '内容区' : '外壳'));
        out.push(where);
      }
      return out;
    `);
    note(
      recovered.every((w) => w === "内容区"),
      `焦点掉了以后按四个方向都落回内容区（实测 ${recovered.join(" / ")}）`,
    );

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
    for (const name of ["首页", "游戏库", "软件库", "下载", "文件", "工具箱", "模拟器"]) {
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
          // 卡片宽不再是固定的 152.7dp：2026-10-11 侧栏下线之后内容区从 1020dp 变成 1232dp，
          // 而 K2 是「6 列摊满」（`repeat(6, minmax(0, 1fr))`）—— 列数、间隙、卡高、卡片内部
          // 四段的位置全部照旧，只有宽度跟着内容区走。所以这条断言改成按内容区宽度**算**：
          // (1232 - 5×16) / 6 = 192dp。哪天真的把卡片改回定宽，这条会红，是故意的。
          const expectedW = ((1280 - 2 * 24 - 5 * 16) / 6) * d;
          note(k2.cols === 6, `K2 网格 6 列（实测 ${k2.cols} 列）`);
          note(Math.abs(k2.cardW - expectedW) < 3,
            `K2 卡片宽 = 内容区 6 等分 = ${expectedW.toFixed(1)}（实测 ${k2.cardW}）`);
          note(Math.abs(k2.cardH - 176 * d) < 3, `K2 卡片高 176dp=${(176 * d).toFixed(1)}（实测 ${k2.cardH}）`);
          /*
           * 第一行顶从画板的 134dp 变成 144dp：用户 2026-10-12 说「分组距离标题太近了不好看」，
           * 所以 `.k2-head .library-group-row` 的 margin-top 从 2dp 加到 12dp —— 整块内容跟着
           * 下移 10dp，这是用户要的取舍（画板值在这里让位给真机手感）。
           */
          note(Math.abs(k2.cardY - 144 * d) < 5, `K2 第一行顶 144dp=${(144 * d).toFixed(1)}（实测 ${k2.cardY}）`);
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
      // ── 焦点规矩（2026-10-11 最终版）：菜单是顶栏里的页签条，**整条不可聚焦**。
      //    内容区里一直按方向键（含 30 步长按）不许跑进页签条；页签条本身一个 [data-focusable]
      //    都没有；焦点掉了只许落回内容区。
      //    0.1.71 那套「内容区按左进侧栏 / 侧栏按右出内容区 / 按 B 回菜单」已经连同可聚焦的
      //    侧栏一起被用户否掉 —— 别再改回去，那是「方向键把焦点送回菜单」的根源。
      const navAll = await page.eval(`
        const mod = await import('/src/hooks/useGamepadNav.ts');
        const zoneOf = (el) => el.closest('[data-focus-zone]')?.getAttribute('data-focus-zone') ?? '-';
        const isNav = (el) => !!el.closest('.nav-items') || zoneOf(el) === mod.SHELL_NAV_ZONE;
        const vis = () => [...document.querySelectorAll('[data-focusable]')].filter((el) => el.offsetParent !== null);
        // 一直按某个方向（30 步），落进「不该去的那一边」就返回步数，否则 0。
        const leaks = (dx, dy, want) => {
          let step = 0;
          while (step++ < 30) {
            mod.moveDirectionalFocus(dx, dy);
            if (want(document.activeElement)) return step;
          }
          return 0;
        };
        const leaked = [];
        let n = 0;
        for (const el of vis()) {
          if (isNav(el) || el.closest('.drawer-root')) continue;
          n++;
          el.focus();
          if (document.activeElement !== el) continue;
          if (leaks(-1, 0, isNav) || leaks(0, -1, isNav) || leaks(0, 1, isNav) || leaks(1, 0, isNav)) {
            leaked.push(zoneOf(el) + ':' + (el.className || '').split(' ')[0] + '|' + (el.textContent || '').trim().slice(0, 6));
          }
        }
        // 页签条本身：不许有任何可聚焦元素；就算有人程序化把焦点放到页签上（Tab / 代码），
        // 按一下方向键也必须落回内容区 —— 不许滞留在页签上，也不许掉到 body。
        const tabs = [...document.querySelectorAll('.nav-item')];
        const navFocusables = document.querySelectorAll('.nav-items [data-focusable]').length;
        const stray = (() => {
          const tab = tabs.find((t) => t.getAttribute('aria-selected') !== 'true' && !t.classList.contains('is-locked')) ?? tabs[0];
          tab?.focus();
          const took = document.activeElement === tab;
          mod.moveDirectionalFocus(1, 0);
          const a = document.activeElement;
          const where = a === document.body ? 'BODY' : a.closest('.nav-items') ? '页签条' : a.closest('.tab-panel') ? '内容区' : '外壳';
          return { took, where };
        })();
        // 焦点掉出池子（按钮变灰 / 被卸载 / 手指点了空白处）之后按方向键 → 只许落回内容区。
        const lost = [];
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          document.activeElement?.blur?.();
          mod.moveDirectionalFocus(dx, dy);
          const a = document.activeElement;
          lost.push(a === document.body ? 'BODY' : isNav(a) || a.closest('.nav-items') ? '页签条' : a.closest('.tab-panel') ? '内容区' : '外壳');
        }
        return { n, leaked, navFocusables, stray, lost, tabs: tabs.length };
      `);
      note(navAll.leaked.length === 0,
        `${name}：内容区 ${navAll.n} 个可聚焦元素按方向键都不会跑进页签条${navAll.leaked.length ? "（漏的：" + navAll.leaked.slice(0, 4).join("、") + "）" : ""}`);
      note(navAll.navFocusables === 0 && navAll.tabs === 9,
        `${name}：页签条 9 项、0 个可聚焦元素（实测 ${navAll.tabs} / ${navAll.navFocusables}）`);
      note(navAll.stray.where === "内容区",
        `${name}：焦点被放到页签上之后按方向键落回内容区（实测 took=${navAll.stray.took} → ${navAll.stray.where}）`);
      note(navAll.lost.every((w) => w === "内容区"),
        `${name}：焦点掉了以后按方向键落回内容区（实测 ${navAll.lost.join(" / ")}）`);
      // 首页 / 下载是占位页，内容区没有可聚焦元素 —— 这一条不适用（没有可落的地方）。
      if (navAll.n > 0) {
        // 点当前页签（手柄上换页是 LB/RB，触摸屏就是点这一下）→ 焦点落进这一页的内容区。
        // 页面按 tab 重挂载，所以等一会儿再看。
        const landed = await page.eval(`
          const tab = [...document.querySelectorAll('.nav-item')].find((b) => b.getAttribute('aria-selected') === 'true');
          if (!tab) return 'no-tab';
          tab.click();
          await new Promise((r) => setTimeout(r, 1000));
          const a = document.activeElement;
          if (a === document.body) return 'body';
          if (a.closest('.nav-items')) return 'nav';
          return a.closest('.tab-panel') ? 'content' : 'shell';
        `);
        note(landed === "content", `${name}：点当前页签落进内容区（实测 ${landed}）`);
      }

      /*
       * 游戏库卡片名字：**长英文名不许露半截字**，而且**底下那层阴影要盖到卡片下沿**
       * （2026-10-12 用户真机两轮截图，两条是同一个地方的合题）。
       *
       * 现场：名字是 "DYNASTY WARRIORS 3: Complete Edition Remastered"、"Mount & Blade: Warband"
       * 这种长名字；`-webkit-line-clamp` 只把盒子高度收到 N 行，多出来的行仍然画在盒子里、由
       * `overflow: hidden` 按**内边距盒**裁掉 —— 裁的那层只要带下内边距，下一行就在那几 dp 里露出半截。
       * 但把下内边距挪走又会让阴影跟着抬高，卡片底部露出一条没压暗的封面（第二张截图里那道硬边）。
       *
       * 所以现在是两层：外层 `.library-name` 贴底（`bottom: 0`）铺渐变，带 facts 时用 padding-bottom
       * 让位；里层 `.library-name-text` 下内边距为 0，专门限行。这里两条一起量。
       */
      /*
       * 0.1.80：① 工具箱里那张「游戏 Mod / 工具」卡整块去掉了（装 Mod 只走游戏卡片菜单）；
       *         ② 游戏卡片上给装了 OptiScaler 的游戏加一颗角标 —— **只给装了的**加。
       */
      if (name === "工具箱") {
        const tbMod = await page.eval(`
          const cards = [...document.querySelectorAll('.k4-card')];
          const titles = cards.map((c) => (c.querySelector('.k4-card-title')?.textContent || '').trim());
          return {
            cards: cards.length,
            titles,
            // 那张卡的去重特征：动作按钮写「查看列表」或者有 OptiScaler / Mod 字样
            hasModCard: cards.some((c) => {
              const t = (c.textContent || '').toLowerCase();
              return t.includes('查看列表') || t.includes('optiscaler') || /\bmod\b/.test(t);
            }),
          };
        `);
        note(
          !tbMod.hasModCard,
          `工具箱：那张 OptiScaler / Mod 卡已经去掉（现有 ${tbMod.cards} 张卡：${tbMod.titles.join("、")}）`,
        );
      }

      if (name === "游戏库") {
        const badges = await page.eval(`
          const preview = await import('/src/data/previewGames.ts');
          const want = new Map(preview.PREVIEW_GAMES.map((g) => [String(g.id), !!g.hasMod]));
          const cards = [...document.querySelectorAll('[data-card-id]')];
          const seen = cards.map((card) => ({
            id: card.getAttribute('data-card-id'),
            has: !!card.querySelector('.library-mod-badge'),
          }));
          return {
            seen,
            wantCount: [...want.values()].filter(Boolean).length,
            // 库里可见的这几张卡里，应该有多少张带角标
            expectShown: seen.filter((row) => want.get(row.id)).length,
          };
        `);
        const withBadge = badges.seen.filter((row) => row.has).length;
        note(
          withBadge > 0 && withBadge === badges.expectShown,
          `游戏库：装了 OptiScaler 的卡片带角标（可见 ${badges.seen.length} 张卡里 ${withBadge} 张带角标，预览数据里应有 ${badges.expectShown} 张）`,
        );
        note(
          badges.seen.length - withBadge > 0,
          `游戏库：没装 Mod 的卡片上确实没有角标（${badges.seen.length - withBadge} 张干净）`,
        );

        /*
         * 角标要**跟着装/卸立刻变**，而不是等下一次全库扫描。
         *
         * 0.1.82 真机反馈「那个 optiscaler 的图标并没有绘制上去」的根因是**扫描缓存版本没升**
         * （老缓存里没有 hasMod 这个字段）—— 那一半靠 `scan.v3` 解决；这一条钉的是另一半：
         * 装/卸 Mod 之后角标必须马上亮/灭，走的是 `setModFlag` 那份即时覆盖。
         */
        const live = await page.eval(`
          // ⚠️ 必须 import **页面真正加载过的那个 URL**：Vite dev 下 HMR 会给模块加「?t=<时间戳>」后缀，
          // 换成裸路径就是另一个模块实例 —— setModFlag 改的是那份拷贝，界面永远不会动
          // （本机实测踩过：断言一直红，看着像 React 没重渲染）。
          const loaded = performance
            .getEntriesByType('resource')
            .map((e) => e.name)
            .filter((n) => n.includes('/src/library/useLocalLibrary.ts'))
            .pop();
          const mod = await import(/* @vite-ignore */ loaded || '/src/library/useLocalLibrary.ts');
          const preview = await import('/src/data/previewGames.ts');
          const withMod = preview.PREVIEW_GAMES.filter((g) => g.hasMod);
          if (withMod.length === 0) return null;
          const sel = '.k1-item [data-card-id="' + withMod[0].id + '"]';
          const before = !!document.querySelector(sel + ' .library-mod-badge');
          mod.setModFlag(String(withMod[0].id), false);
          await new Promise((r) => setTimeout(r, 150));
          const after = !!document.querySelector(sel + ' .library-mod-badge');
          mod.setModFlag(String(withMod[0].id), undefined);
          await new Promise((r) => setTimeout(r, 150));
          const restored = !!document.querySelector(sel + ' .library-mod-badge');
          return { before, after, restored };
        `);
        /*
         * 装 Mod 面板：**默认只有"一个版本 + 安装"**（用户 2026-10-12 真机照片：「其实你这些
         * 主程序啥的一对说明有什么用呢？用户又看不懂，你就一个选择一个安装不就好了吗？」），
         * 而且面板盒子必须**整个在屏幕里**（照片里它长到顶上一行被切掉半行）。
         */
        /*
         * 「全部」= **所有内容**，不管有没有被分到别的分组（用户 2026-10-12，
         * 「游戏库和软件库同理」）。原行为是「全部 = 未分组」，所以东西一分组就从"全部"里消失。
         *
         * 怎么造现场：分组与归属都存在 localStorage（`handheld-launcher.groups.<kind>`）——
         * 直接写一份"第一张卡属于探针分组"，重载页面，再看「全部」里它还在不在。
         */
        const firstCardId = await page.eval(`
          return document.querySelector('[data-card-id]')?.getAttribute('data-card-id') ?? null;
        `);
        if (!firstCardId) {
          note(false, "游戏库：找不到任何卡片，量不到「全部」的口径");
        } else {
          await page.eval(`
            localStorage.setItem(
              'handheld-launcher.groups.games',
              JSON.stringify({
                groups: [{ id: 'probe-group', name: '探针分组' }],
                membership: { '${firstCardId}': 'probe-group' },
                names: {},
              }),
            );
            return true;
          `);
          await page.goto(URL);
          await page.wait(1600);
          const grouped = await page.eval(`
            const chip = [...document.querySelectorAll('.group-chip')].find((c) =>
              (c.textContent || '').includes('探针分组'),
            );
            const count = (chip?.querySelector('.k1-chip-count')?.textContent || '').trim();
            const inAll = !!document.querySelector('[data-card-id="${firstCardId}"]');
            const rendered = document.querySelectorAll('.k1-item').length;
            const allChip = [...document.querySelectorAll('.group-chip')].find((c) =>
              (c.textContent || '').trim().startsWith('全部') ||
              (c.textContent || '').trim().startsWith('All'),
            );
            const allCount = (allChip?.querySelector('.k1-chip-count')?.textContent || '').trim();
            return { count, inAll, rendered, allCount };
          `);
          note(
            grouped.inAll && Number(grouped.allCount) === grouped.rendered,
            `游戏库：「全部」里有所有内容（分到分组的卡仍在全部里=${grouped.inAll}；全部 chip 写「${grouped.allCount}」= 实际 ${grouped.rendered} 张）`,
          );
          note(
            grouped.count === '1',
            `游戏库：那个分组自己数出 1 张（实测「${grouped.count}」）`,
          );
          // 收拾现场：把探针分组删掉、重载回去，别影响后面的断言。
          await page.eval(`localStorage.removeItem('handheld-launcher.groups.games'); return true;`);
          await page.goto(URL);
          await page.wait(1400);
        }

        const modPanel = await page.eval(`
          // 打开卡片菜单 → 点「安装 Mod / 工具」
          document.querySelector('.k1-actions .k1-btn.is-icon')?.click();
          await new Promise((r) => setTimeout(r, 400));
          const entry = [...document.querySelectorAll('.card-menu button')].find((b) =>
            /安装 Mod|Install Mod/.test(b.textContent || ''),
          );
          entry?.click();
          await new Promise((r) => setTimeout(r, 600));
          const panel = document.querySelector('.group-create-panel');
          if (!panel) return null;
          const r = panel.getBoundingClientRect();
          const dllButtons = [...panel.querySelectorAll('button')].filter((b) =>
            /\.dll/.test(b.textContent || ''),
          ).length;
          const versionish = [...panel.querySelectorAll('button')].filter((b) =>
            /^(v\d|自带版|Bundled)/.test((b.textContent || '').trim()),
          ).length;
          return {
            fits: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
            top: +r.top.toFixed(1),
            bottom: +r.bottom.toFixed(1),
            viewportH: window.innerHeight,
            dllButtons,
            versionish,
            hasDetails: [...panel.querySelectorAll('button')].some((b) =>
              /显示详情|Show details/.test(b.textContent || ''),
            ),
          };
        `);
        /*
         * 用户 2026-10-12 真机反馈：「但凡我打开过一次显示详情后，之后就每次都显示详情了」。
         * 这两个开关是"这一次查看"的临时状态，面板关了就该复位。这里照原场景走一遍：
         * 打开 → 点开详情 → 关掉 → 再打开，必须又是收起的。
         */
        const reset = await page.eval(`
          const openMod = async () => {
            document.querySelector('.k1-actions .k1-btn.is-icon')?.click();
            await new Promise((r) => setTimeout(r, 400));
            const entry = [...document.querySelectorAll('.card-menu button')].find((b) =>
              /安装 Mod|Install Mod/.test(b.textContent || ''),
            );
            entry?.click();
            await new Promise((r) => setTimeout(r, 600));
            return document.querySelector('.group-create-panel');
          };
          const closeMod = async () => {
            const panel = document.querySelector('.group-create-panel');
            const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) =>
              /^(关闭|Close)$/.test((b.textContent || '').trim()),
            );
            btn?.click();
            await new Promise((r) => setTimeout(r, 400));
          };
          const detailsOpen = (panel) =>
            [...(panel?.querySelectorAll('button') ?? [])].some((b) =>
              /收起详情|Hide details/.test(b.textContent || ''),
            );
          const panel1 = await openMod();
          if (!panel1) return null;
          // 点开「显示详情」
          [...panel1.querySelectorAll('button')]
            .find((b) => /显示详情|Show details/.test(b.textContent || ''))
            ?.click();
          await new Promise((r) => setTimeout(r, 250));
          const openedAfterClick = detailsOpen(document.querySelector('.group-create-panel'));
          await closeMod();
          const panel2 = await openMod();
          const reopenedCollapsed = panel2 ? !detailsOpen(panel2) : false;
          await closeMod();
          return { openedAfterClick, reopenedCollapsed };
        `);
        note(
          !!reset && reset.openedAfterClick && reset.reopenedCollapsed,
          reset
            ? `装 Mod 面板：关掉再打开时「显示详情」是收起的（点开后展开=${reset.openedAfterClick}，重开收起=${reset.reopenedCollapsed}）`
            : "装 Mod 面板：没能按原场景走一遍（打开失败）",
        );

        // 量完**把面板关掉** —— 留着它会挡住后面"按 B 呼出卡片菜单"那条断言（本机实测踩到：
        // 面板还开着时，菜单按钮点下去什么都不发生，那条断言就假红）。
        await page.eval(`
          const panel = document.querySelector('.group-create-panel');
          const closeBtn = [...(panel?.querySelectorAll('button') ?? [])].find((b) =>
            /^(关闭|Close)$/.test((b.textContent || '').trim()),
          );
          closeBtn?.click();
          await new Promise((r) => setTimeout(r, 300));
          return true;
        `);
        note(
          !!modPanel && modPanel.fits,
          modPanel
            ? `装 Mod 面板整个在屏幕里（顶 ${modPanel.top} / 底 ${modPanel.bottom} / 视口高 ${modPanel.viewportH}）`
            : "装 Mod 面板没打开（量不到 .group-create-panel）",
        );
        note(
          !!modPanel && modPanel.dllButtons === 0 && modPanel.versionish <= 1 && modPanel.hasDetails,
          modPanel
            ? `装 Mod 面板默认不给术语（.dll 按钮 ${modPanel.dllButtons} 个、版本按钮 ${modPanel.versionish} 个 ≤1、有「显示详情」=${modPanel.hasDetails}）`
            : "装 Mod 面板没打开，量不到默认视图",
        );
        note(
          !!live && live.before && !live.after && live.restored,
          live
            ? `游戏库：装/卸 Mod 后角标立刻跟着变（卸掉→消失=${!live.after}，还原→回来=${live.restored}）`
            : "游戏库：预览数据里没有 hasMod 的游戏，量不到角标联动",
        );
      }

      if (name === "游戏库") {
        const long = await page.eval(`
          const names = ["DYNASTY WARRIORS 3: Complete Edition Remastered", "Mount & Blade: Warband", "Red Dead Redemption 2"];
          const items = [...document.querySelectorAll('.k1-item')];
          items.forEach((item, i) => {
            const el = item.querySelector('.library-name-text');
            if (el && names[i]) el.textContent = names[i];
          });
          await new Promise((r) => setTimeout(r, 300));
          const out = [];
          for (const item of items.slice(0, 3)) {
            const shade = item.querySelector('.library-name');
            const text = item.querySelector('.library-name-text');
            const card = item.querySelector('.k1-card');
            if (!shade || !text || !card) continue;
            const cs = getComputedStyle(text);
            const lines = item.classList.contains('is-current') ? 2 : 1;
            const lineH = parseFloat(cs.lineHeight);
            const padBottom = parseFloat(cs.paddingBottom);
            const textBox = text.getBoundingClientRect();
            const shadeBox = shade.getBoundingClientRect();
            const cardBox = card.getBoundingClientRect();
            const facts = item.querySelector('.k1-card-facts');
            out.push({
              名字: (text.textContent || '').slice(0, 16),
              有facts: !!facts,
              限行层下内边距: padBottom,
              露出的半截字: Math.max(0, Math.min(text.scrollHeight - text.clientHeight, padBottom)),
              框高差: +(textBox.height - lines * lineH).toFixed(2),
              阴影贴底差: +(cardBox.bottom - shadeBox.bottom).toFixed(2),
              facts不压字: facts ? +(facts.getBoundingClientRect().top - textBox.bottom).toFixed(2) : null,
            });
          }
          return out;
        `);
        const leak = long.reduce((max, row) => Math.max(max, row.露出的半截字), 0);
        const pad = long.reduce((max, row) => Math.max(max, row.限行层下内边距), 0);
        const fit = long.reduce((max, row) => Math.max(max, Math.abs(row.框高差)), 0);
        const bottom = long.reduce((max, row) => Math.max(max, Math.abs(row.阴影贴底差)), 0);
        const factsGap = long.reduce(
          (min, row) => (row.facts不压字 === null ? min : Math.min(min, row.facts不压字)),
          Infinity,
        );
        note(leak === 0 && pad === 0,
          `K1 长名字不露半截字（限行层下内边距 ${pad}，露出的半截字 ${leak}）`);
        note(fit < 1.5, `K1 名字框高 = N 行（最大偏差 ${fit.toFixed(2)}）`);
        note(bottom < 1,
          `K1 名字的阴影盖到卡片下沿（最大差 ${bottom}dp；${long.filter((r) => r.有facts).length} 张带 facts）`);
        note(factsGap === Infinity || factsGap > 2,
          `K1「时长 · 体积」那一行没压住名字（最小间隙 ${factsGap === Infinity ? "-" : factsGap}）`);
      }

      /*
       * 工具箱：行内按钮之间要留间距（2026-10-12 用户真机截图「按钮间没间距」）。
       *
       * 真机上这两张卡才有数据（浏览器没有后端），所以这里照真机的结构与文案**手搭一份 DOM**，
       * 量的还是真 CSS：行高 34 + 行距 4 − 按钮 28 = 按钮之间 10dp。
       * 顺带钉住「行尾那段小字可省略」—— 日志那行是 `C:\\Users\\<用户名>\\AppData\\Roaming\\handheld-launcher`，
       * 用户名一长就会顶出卡片边缘。
       */
      /*
       * 0.1.78：用户 2026-10-12 晚的真机反馈（四张照片 + 一条补充）——
       *   ① 软件库分组行离标题太近；② 搜索框焦点环没盖住整个框（照片里是"双边框"）；
       *   ④ 底部按键提示条要去掉（只留 B 呼出菜单）；⑤ 分组 chip 不该能聚焦（切换只归 LT/RT）。
       */
      if (name === "软件库") {
        const fb = await page.eval(`
          const dp = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1;
          const title = document.querySelector('.k2-head h2')?.getBoundingClientRect() ?? null;
          const row = document.querySelector('.k2-head .library-group-row')?.getBoundingClientRect() ?? null;
          const chips = [...document.querySelectorAll('.group-chip')];
          const search = document.querySelector('.k2-search');
          const input = document.querySelector('.k2-search-input');
          // 焦点环：把焦点放进输入框，再量「环画在哪」「里面还有没有第二圈」。
          // 上一版的毛病就是环画了两圈：外圈在 .k2-search 上（对），内圈是里面那颗按钮自己的
          // outline（错）—— 框有 12dp 内边距，内圈自然小一圈，看着就是「边框没盖住搜索框」。
          input?.focus();
          const ring = search ? getComputedStyle(search) : null;
          const kids = search
            ? [...search.querySelectorAll('button, input')].map((el) => getComputedStyle(el).outlineStyle)
            : [];
          return {
            dp,
            gap: title && row ? +(row.top - title.bottom).toFixed(2) : null,
            chips: chips.length,
            chipFocusable: chips.filter((c) => c.hasAttribute('data-focusable')).length,
            ringShadow: ring ? ring.boxShadow : "",
            kidOutlines: kids,
            hints: !!document.querySelector('.shell-hints'),
          };
        `);
        note(
          fb.gap != null && fb.gap >= 8 * fb.dp,
          `软件库：分组行与标题之间留了间距（实测 ${fb.gap}px，要求 ≥ ${(8 * fb.dp).toFixed(0)}px）`,
        );
        note(
          fb.chips > 0 && fb.chipFocusable === 0,
          `软件库：分组 chip 不进焦点池（${fb.chips} 个 chip / ${fb.chipFocusable} 个可聚焦），鼠标仍可点`,
        );
        note(
          !!fb.ringShadow && fb.ringShadow !== "none" && fb.kidOutlines.every((o) => o === "none"),
          `软件库：搜索框焦点环只画在整个框上（外圈 ${fb.ringShadow ? "有" : "无"}，里面第 ${fb.kidOutlines.length} 个子控件 outline=${fb.kidOutlines.join("/") || "-"}）`,
        );
        note(!fb.hints, `底部按键提示条已去掉（实测${fb.hints ? "还在" : "不在"}）`);
      }

      /*
       * 0.1.78：③ 左右键只管左右 —— 不许从卡片行跳到上面那排工具按钮；
       *         ⑥ B 呼出的按钮组贴卡片右下角、压住卡片一部分、且不越出屏幕。
       */
      if (name === "游戏库") {
        const nav = await page.eval(`
          const card = document.querySelector('[data-card-id]');
          card?.focus();
          const mod = await import('/src/hooks/useGamepadNav.ts');
          const bandOf = (el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          };
          const band = card ? bandOf(card) : null;
          let escaped = 0;
          let sample = null;
          if (band) {
            for (const dx of [1, 1, 1, -1, -1, -1]) {
              mod.moveDirectionalFocus(dx, 0);
              const el = document.activeElement;
              if (!el || el === document.body) continue;
              const r = el.getBoundingClientRect();
              const sameRow = r.bottom > band.top + 1 && r.top < band.bottom - 1;
              if (!sameRow) {
                escaped += 1;
                sample = (el.textContent || el.className || '').toString().trim().slice(0, 24);
              }
            }
          }
          return { escaped, sample, hasBand: !!band };
        `);
        note(
          nav.hasBand && nav.escaped === 0,
          `游戏库：卡片行上按左右键不会跑出这一行（跑出去 ${nav.escaped} 次${nav.sample ? "，例如「" + nav.sample + "」" : ""}）`,
        );

        const menu = await page.eval(`
          const dp = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1;
          const card = document.querySelector('[data-card-id]');
          card?.focus();
          const open = document.querySelector('.k1-actions .k1-btn.is-icon');
          open?.click();
          await new Promise((r) => setTimeout(r, 500));
          const menuEl = document.querySelector('.card-menu');
          if (!menuEl || !card) return null;
          const m = menuEl.getBoundingClientRect();
          const c = card.getBoundingClientRect();
          return {
            dp,
            rightAligned: +(c.right - m.right).toFixed(2),
            overlapCard: +(c.bottom - m.bottom).toFixed(2),
            insideView: m.left >= 0 && m.top >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight,
            menuW: +m.width.toFixed(2),
            cardW: +c.width.toFixed(2),
          };
        `);
        note(
          !!menu && menu.insideView && menu.rightAligned <= 2 * menu.dp && menu.overlapCard > 0,
          menu
            ? `游戏库：呼出的按钮组贴卡片右下角（右边缘差 ${menu.rightAligned}px、压在卡片内 ${menu.overlapCard}px、完全在屏幕内=${menu.insideView}）`
            : "游戏库：呼出的按钮组没打开（量不到 .card-menu）",
        );
        // 关掉菜单再走：Escape 走的是 App.tsx 里 closeDialog 那条路（手柄 B 的键盘等价键）。
        await page.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
        await sleep(250);
      }

      /*
       * 0.1.79：工具箱下面那两张卡（运行库 / 系统维护）**要跟着内容长高**。
       *
       * 用户 2026-10-12 真机照片：「这里的两个地方都没显示全，你就不能把他俩增高嘛？反正又没有
       * 其它内容，空间不是不够用啊」—— 原来是 `height: 157dp + overflow: hidden`（照画板抄的），
       * 真机上三行/两行就把最后一行切了半截。
       *
       * 浏览器预览里那两张卡是空的（真机数据来自后端），所以这里**自己塞几行进去**再量：
       * 卡片高度必须超过写死时的 157dp，而且最后一行得**整个在卡片里**。
       */
      if (name === "工具箱") {
        const tb = await page.eval(`
          const dp = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1;
          const cards = [...document.querySelectorAll('.k4-pair > .k4-card')];
          if (cards.length === 0) return null;
          cards.forEach((card, i) => {
            const host = card.querySelector('.k4-rows') || card;
            for (let n = 0; n < 5; n++) {
              const row = document.createElement('div');
              row.className = 'k4-row-item';
              row.innerHTML =
                '<span class="k4-tick is-on" aria-hidden>✓</span><span>探测行 ' + i + '-' + n + '</span>';
              host.appendChild(row);
            }
          });
          return {
            dp,
            cards: cards.map((card) => {
              const r = card.getBoundingClientRect();
              const rows = [...card.querySelectorAll('.k4-row-item')];
              const last = rows.length ? rows[rows.length - 1].getBoundingClientRect() : null;
              return {
                h: +r.height.toFixed(2),
                rows: rows.length,
                clipped: last ? +(last.bottom - r.bottom).toFixed(2) : null,
              };
            }),
          };
        `);
        note(
          !!tb && tb.cards.every((c) => c.rows >= 5 && c.clipped !== null && c.clipped <= 1),
          tb
            ? `工具箱：下面两张卡跟着内容长高（高 ${tb.cards.map((c) => c.h).join(" / ")}px，最后一行越界 ${tb.cards.map((c) => c.clipped).join(" / ")}px）`
            : "工具箱：找不到 .k4-pair > .k4-card（两张并列的卡）",
        );
        note(
          !!tb && tb.cards.every((c) => c.h > 157 * tb.dp),
          tb
            ? `工具箱：卡高确实超过了写死的 157dp=${(157 * tb.dp).toFixed(1)}（实测 ${tb.cards.map((c) => c.h).join(" / ")}）`
            : "工具箱：量不到卡高",
        );
      }

      if (name === "工具箱") {
        const k4 = await page.eval(`
          const host = document.querySelector('.k4-pair');
          if (!host) return null;
          const keep = host.innerHTML;
          const runtimeRow = (on, name, detail, action) =>
            '<div class="k4-row-item"><span class="k4-tick' + (on ? ' is-on' : '') + '">✓</span>'
            + '<strong>' + name + '</strong><small>' + detail + '</small>'
            + '<button type="button" class="k4-card-action" data-focusable>' + action + '</button></div>';
          host.innerHTML = '<section class="k4-card"><h3 class="k4-card-title">游戏运行库</h3>'
            + '<div class="k4-rows">'
            + runtimeRow(true, 'Visual C++ 2015-2022 (x64)', '多数新游戏依赖的官方运行库（64 位）。', '重装')
            + runtimeRow(false, 'Visual C++ 2015-2022 (x86)', '部分老游戏 / 32 位组件需要。', '安装')
            + runtimeRow(true, '.NET 桌面运行时 (x64)', '部分后端与工具依赖。', '重装')
            + '</div></section>'
            + '<section class="k4-card"><h3 class="k4-card-title">系统维护</h3><div class="k4-rows">'
            + '<div class="k4-row-item"><span class="k4-tick is-on">✓</span><strong>日志 11 KB</strong>'
            + '<small>C:\\Users\\一个很长很长的用户名\\AppData\\Roaming\\handheld-launcher</small></div>'
            + '</div></section>';
          await new Promise((r) => setTimeout(r, 250));
          const buttons = [...document.querySelectorAll('.k4-rows .k4-card-action')].map((b) => b.getBoundingClientRect());
          const gaps = buttons.slice(1).map((r, i) => +(r.top - buttons[i].bottom).toFixed(2));
          const card = document.querySelectorAll('.k4-pair .k4-card')[1];
          const small = document.querySelector('.k4-rows .k4-row-item small');
          const box = card.getBoundingClientRect();
          const sr = small.getBoundingClientRect();
          const res = {
            gaps,
            buttonH: buttons[0] ? +buttons[0].height.toFixed(2) : 0,
            小字在卡内: sr.right <= box.right - 8,
            小字可省略: getComputedStyle(small).textOverflow === 'ellipsis',
          };
          host.innerHTML = keep;
          return res;
        `);
        if (!k4) {
          note(false, "工具箱：找不到 .k4-pair，量不了行内按钮间距");
        } else {
          note(k4.gaps.length === 2 && k4.gaps.every((g) => g >= 8),
            `K4 行内按钮之间留了间距（${k4.gaps.join(" / ")}dp，按钮高 ${k4.buttonH}）`);
          note(k4.小字在卡内 && k4.小字可省略,
            `K4 行尾小字不会顶出卡片（在卡内=${k4.小字在卡内}，可省略=${k4.小字可省略}）`);
        }
      }

      /*
       * 模拟器：**六张卡都要能自动装**，而且 Switch 那张是 Eden（2026-10-12 用户要求换掉
       * Ryujinx —— 它 2024 年下架，那张卡原来只写「本程序不提供下载」，等于这一格永远装不了）。
       * 浏览器预览用的是 `src/data/previewEmulators.ts` 的假数据，但**形状与后端一致**，
       * 所以「有没有手动项 / 模拟器叫什么」这两条在这里量得出来。
       */
      if (name === "模拟器") {
        const cards = await page.eval(`
          const rows = [...document.querySelectorAll('.emu-card')].map((card) => ({
            badge: (card.querySelector('.emu-badge')?.textContent || '').trim(),
            emulator: (card.querySelector('.emu-card-emu')?.textContent || '').trim(),
            manual: card.classList.contains('is-manual'),
            hasInstall: !!card.querySelector('.emu-actions .emu-btn.is-primary'),
          }));
          return rows;
        `);
        const manual = cards.filter((c) => c.manual);
        note(cards.length === 6 && manual.length === 0,
          `模拟器：6 张卡都能自动装（手动项 ${manual.length} 个${manual.length ? "：" + manual.map((c) => c.badge).join("、") : ""}）`);
        const sw = cards.find((c) => c.badge === "NS");
        note(!!sw && sw.emulator.includes("Eden"),
          `模拟器：Switch 卡用的是 Eden（实测「${sw ? sw.emulator : "-"}」）`);

        /*
         * 「游戏列表」那一页（2026-10-12 用户要求：ROM 下载先不做，「留下列表页面就可以」）。
         *
         * 两条：① 六张卡都有这颗按钮；② 点开之后面板里**有 ROM 目录路径 + 一句如实的「来源还没接」**，
         * 而且**没有任何下载按钮**（这一版不摆按了没反应的假按钮）。
         * 顺带钉住目录名的一致性：ps2 / switch / retro 三个与「导入 ROM」那张表重叠的平台，
         * 两边的子目录名必须同一个字符串（导入到 A、列表看 B 是最难查的那种 bug）。
         */
        const roms = await page.eval(`
          const cards = [...document.querySelectorAll('.emu-card')];
          const buttons = cards.map((card) => {
            const btn = [...card.querySelectorAll('.emu-actions .emu-btn')].find((b) =>
              (b.textContent || '').includes('游戏列表'),
            );
            return btn ? (card.querySelector('.emu-badge')?.textContent || '').trim() : null;
          });
          const first = cards[1]?.querySelector('.emu-actions .emu-btn:not(.is-primary)');
          // 点开第一张卡（PS2）的「游戏列表」
          [...cards[1].querySelectorAll('.emu-btn')]
            .find((b) => (b.textContent || '').includes('游戏列表'))
            ?.click();
          await new Promise((r) => setTimeout(r, 600));
          const panel = document.querySelector('.roms-panel');
          const rows = panel ? [...panel.querySelectorAll('.k4-row-item')].length : -1;
          const downloadish = panel
            ? [...panel.querySelectorAll('button')].filter((b) =>
                /下载|Download/i.test(b.textContent || ''),
              ).length
            : -1;
          return {
            withButton: buttons.filter(Boolean),
            panelOpen: !!panel,
            text: panel ? (panel.textContent || '') : '',
            rows,
            downloadish,
          };
        `);
        note(roms.withButton.length === 6,
          `模拟器：6 张卡都有「游戏列表」（实测 ${roms.withButton.length} 张：${roms.withButton.join("、")}）`);
        note(roms.panelOpen && roms.text.includes("ROM") && /来源还没接|No online source/.test(roms.text),
          `模拟器：游戏列表面板能打开、有 ROM 目录与「来源还没接」说明（行数 ${roms.rows}）`);
        note(roms.downloadish === 0,
          `模拟器：游戏列表里没有下载按钮（这一版不摆假按钮，实测 ${roms.downloadish} 个）`);
        if (SHOTS) {
          const box = await page.eval(`
            const panel = document.querySelector('.roms-panel');
            if (!panel) return null;
            const r = panel.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 };
          `);
          if (box) await page.shot(join(SHOTS, "roms-panel.png"), box);
        }

        // 目录名一致性：模拟器卡上的 `romDir` 与「导入 ROM」那张表的 `folder`
        // 必须是同一个字符串（重叠的是 ps2 / switch / retro）—— 导入到 A、列表看 B
        // 是最难查的那种 bug，所以拿真表比一遍。
        const dirs = await page.eval(`
          const preview = await import('/src/data/previewEmulators.ts');
          const meta = await import('/src/files/taskMeta.ts');
          const table = new Map(meta.ROM_PLATFORMS.map((row) => [row.key, row.folder]));
          return preview.PREVIEW_EMULATORS.map((row) => ({
            id: row.id,
            romDir: row.romDir,
            table: table.get(row.id) ?? null,
          }));
        `);
        const overlap = dirs.filter((d) => d.table !== null);
        const mismatched = overlap.filter((d) => d.romDir !== d.table);
        note(
          overlap.length === 3 && mismatched.length === 0,
          `模拟器：ROM 目录名与「导入 ROM」表一致（重叠 ${overlap.length} 个：${overlap
            .map((d) => d.id)
            .join("、")}${mismatched.length ? "；不一致：" + mismatched.map((d) => d.id).join("、") : ""}）`,
        );
      }

      /*
       * 模拟器：同一行里六张卡必须等高、按钮在同一条线上（2026-10-12 用户真机截图「不对齐」）。
       * 原来是 align-items: start，各卡按内容收 —— 短卡与长卡底边差半张卡。
       */
      if (name === "模拟器") {
        const emu = await page.eval(`
          const round = (n) => +n.toFixed(1);
          const rows = new Map();
          for (const card of document.querySelectorAll('.emu-grid .emu-card')) {
            const r = card.getBoundingClientRect();
            const key = Math.round(r.top / 50);
            if (!rows.has(key)) rows.set(key, []);
            rows.get(key).push(card);
          }
          const out = [];
          for (const [, cards] of rows) {
            const bottoms = cards.map((c) => round(c.getBoundingClientRect().bottom));
            const actions = cards.map((c) => {
              const a = c.querySelector('.emu-actions');
              return a ? round(a.getBoundingClientRect().bottom) : null;
            });
            out.push({
              卡片数: cards.length,
              底边齐: new Set(bottoms).size === 1,
              按钮底齐: new Set(actions.filter((x) => x !== null)).size === 1,
            });
          }
          return out;
        `);
        note(emu.length > 0 && emu.every((row) => row.底边齐 && row.按钮底齐),
          `模拟器：每行卡片等高、按钮在同一条线上（${emu.map((r) => r.卡片数 + "张/" + (r.底边齐 && r.按钮底齐 ? "齐" : "不齐")).join("、")}）`);
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
        /*
         * 文件栏左缘（单栏）= 安全边 24 + 位置栏 200 + 间隙 16 = 240dp。
         * 0.1.71 之前侧栏占掉左边 236dp，所以那时是 476 —— 2026-10-11 菜单搬去顶栏之后
         * 整页左移 236dp、宽了 236dp。下面这些 x 一律写成**相对文件栏左缘的偏移**
         * （画板 K7 的原始标注就是「名称 +16 / 大小 +396 / 修改时间 +506」，
         * 表头 16dp 内边距也算在里面）—— 以后再动外壳，偏移不用重算。
         */
        const col = 240 * d;
        if (!k7 || !k7.row || !k7.bar) {
          note(false, "文件页是 K7：找不到 .k7-row / .k7-bar");
        } else {
          note(Math.abs(k7.crumb.y - 52 * d) < 2.5 && Math.abs(k7.crumb.h - 30 * d) < 1.5,
            `K7 面包屑 chip：顶边 52dp、高 30dp（实测 ${k7.crumb.y} / ${k7.crumb.h}）`);
          note(k7.crumbs >= 2, `K7 面包屑有分隔的层级（${k7.crumbs} 片）`);
          note(Math.abs(k7.places.x - 24 * d) < 1.5 && Math.abs(k7.places.w - 200 * d) < 1.5 && Math.abs(k7.places.y - 98 * d) < 2.5,
            `K7 位置栏 200dp 起于内容区左缘 24 / 98（实测 ${k7.places.x} / ${k7.places.y} / 宽 ${k7.places.w}）`);
          note(k7.placeStep !== null && Math.abs(k7.placeStep - 32 * d) < 1.5,
            `K7 位置行步进 32dp（实测 ${k7.placeStep}）`);
          note(Math.abs(k7.head.y - 98 * d) < 2.5 && Math.abs(k7.head.h - 34 * d) < 2,
            `K7 表头顶边 98dp、高 34dp（实测 ${k7.head.y} / ${k7.head.h}）`);
          note(
            k7.headX.length === 3 &&
              Math.abs(k7.headX[0] - (col + 16 * d)) < 4 &&
              Math.abs(k7.headX[1] - (col + 396 * d)) < 4 &&
              Math.abs(k7.headX[2] - (col + 506 * d)) < 4,
            `K7 表头三列落在文件栏 +16 / +396 / +506（实测 ${k7.headX.map((v) => Math.round(v - col)).join(" / ")}）`,
          );
          note(Math.abs(k7.row.y - 146 * d) < 3 && Math.abs(k7.row.h - 39 * d) < 2,
            `K7 首行顶边 146dp、行盒 39dp（实测 ${k7.row.y} / ${k7.row.h}）`);
          note(k7.rowStep !== null && Math.abs(k7.rowStep - 46 * d) < 1.5,
            `K7 行步进 46dp（实测 ${k7.rowStep}）`);
          note(Math.abs(k7.row.x - col) < 1.5 && Math.abs(k7.row.right - 1256 * d) < 1.5,
            `K7 行盒横跨 ${col}..1256（实测 ${k7.row.x}..${k7.row.right}）`);
          note(Math.abs(k7.iconX - (col + 14 * d)) < 3 && Math.abs(k7.nameX - (col + 46 * d)) < 3.5,
            `K7 行图标 / 名称落在文件栏 +14 / +46（实测 ${k7.iconX - col} / ${k7.nameX - col}）`);
          note(Math.abs(k7.sizeX - (col + 397 * d)) < 4 && Math.abs(k7.timeX - (col + 507 * d)) < 4,
            `K7 行内大小 / 时间落在文件栏 +397 / +507（实测 ${k7.sizeX - col} / ${k7.timeX - col}）`);
          // 容差 4 而不是 3：两个尺寸实测都是 608dp（画板值 610，差的 2dp 是亚像素取整），
          // 720p 上量到 608 → 差 2 稳稳过；1080p 上 ×1.5 之后是 912 对 915 —— **正好卡在 3 的边界上**，
          // 于是这条断言在 1080p 永远红（2026-10-11 实测：把本次改动全部还原，红法一模一样）。
          // 一条永远红的断言比没有断言更糟：真出问题时反而看不见。
          note(Math.abs(k7.bar.y - 610 * d) < 4 && Math.abs(k7.bar.h - 46 * d) < 1.5,
            `K7 底部操作条顶边 610dp、高 46dp（实测 ${k7.bar.y} / ${k7.bar.h}）`);
          note(Math.abs(k7.bar.x - col) < 1.5 && Math.abs(k7.bar.right - 1256 * d) < 1.5,
            `K7 操作条宽度跟着文件栏走 ${col}..1256（实测 ${k7.bar.x}..${k7.bar.right}）`);
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
          // 9 个（0.1.61 加的）：画板的 8 个 + 「属性」—— Y 在有选中项时改成「剪切」了，
          // 属性得从菜单里挪一颗出来，否则手柄上就只剩菜单一条路（见 FilesPage 的 CHIP_KEYS）。
          note(inter.chips === 9, `K7 底部操作条 9 个 chip（实测 ${inter.chips}）`);
          note(inter.picked === 1 && inter.copyOn && inter.renameOn && inter.note.includes("已选"),
            `K7 选中一项后操作条跟着变（选中 ${inter.picked} 项 / 复制${inter.copyOn ? "亮" : "灰"} / 提示「${inter.note}」）`);
        }
      }

      // 工具箱 = K4：**0.1.65 删掉了 TDP 那张主卡（`.k4-main`）与右侧两张 90 高的小卡**，
      // 画板那套「主卡 616×196 / 右侧两卡 / 底部两卡 490×157」的数字因此不再适用
      // （照抄画板只会得到一条永远红的断言，真出问题时反而看不见）。
      // 这一版只留三条还成立的：头部有标题、自检按钮 32dp 且贴右安全边、卡片都在安全边内。
      if (name === "工具箱") {
        const k4 = await page.eval(`
          const rect = (el) => { const r = el.getBoundingClientRect();
            return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), right: +r.right.toFixed(2) }; };
          const box = (sel) => { const el = document.querySelector(sel); return el ? rect(el) : null; };
          const cards = [...document.querySelectorAll('.k4-body .k4-card')];
          return {
            dp: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dp')) || 1,
            head: box('.k4-head h2'),
            self: box('.k4-selfcheck'),
            cards: cards.map(rect),
          };
        `);
        const d = k4 ? k4.dp : 1;
        if (!k4 || !k4.head || !k4.self) {
          note(false, "工具箱是 K4：找不到头部标题或自检按钮");
        } else {
          note(Math.abs(k4.self.h - 32 * d) < 2 && Math.abs(k4.self.right - 1256 * d) < 2,
            `K4 自检按钮高 32dp、贴右安全边（实测 ${k4.self.h} / ${k4.self.right}）`);
          note(k4.cards.length > 0 && k4.cards.every((c) => c.right <= 1256 * d + 2 && c.x >= 24 * d - 2),
            `K4 卡片都在内容区安全边内（${k4.cards.length} 张，最右 ${Math.max(...k4.cards.map((c) => c.right))}）`);
        }
      }

      if (SHOTS) {
        const p = join(SHOTS, `tab-${name}-${width}x${height}.png`);
        await page.shot(p);
      }
    }

    /*
     * 封面回退链：**竖封面 404 的游戏也要有图**（2026-10-12 用户真机截图「封面没正确显示」）。
     *
     * 真机现场：《DYNASTY WARRIORS 3: Complete Edition Remastered》（appid 3841510）——
     * `library_600x900.jpg` / `library_600x900_2x.jpg` / `library_capsule.jpg` / `header.jpg`
     * 全是 404，**只有 `library_hero.jpg` 是 200**（hero 用的就是它）。没有这一档，
     * 卡片那张竖封面就是一块空渐变，而同一个游戏的大图却好好的，看着像「只有这张卡的封面坏了」。
     *
     * 怎么造现场：用 CDP 把那几个 URL 拦下来、**延迟**失败 —— 等价于真 404。
     * （不能用 `Network.setBlockedURLs`：那是瞬间失败，错误事件可能早于 React 挂上 onError，
     * 图片会一直停在破图状态，测试失真 —— 本机实测踩过。）
     */
    /*
     * 这一档（宽图）**由我们自己喂一张 1×1 PNG**，不走真实 CDN。
     *
     * 为什么：断言要证明的是**我们这条回退链走到了宽图**，而不是"Steam 的 CDN 此刻活着"。
     * 之前直接放行让它去真拉 `library_hero.jpg`，CDN 一慢/一抖就有卡片继续退到下一档，
     * 于是这条断言在 1920×1080 上反复变红（2026-10-12 实测：同样代码两次跑出 2/12 与 6/12）。
     * 自己 fulfill 之后，链路的输入是确定的，断言才真正锁住我们的行为。
     */
    const PIXEL_PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*library_600x900*", requestStage: "Request" },
        { urlPattern: "*library_capsule*", requestStage: "Request" },
        { urlPattern: "*header.jpg", requestStage: "Request" },
        { urlPattern: "*library_hero.jpg", requestStage: "Request" },
      ],
    });
    page.on("Fetch.requestPaused", ({ requestId, request }) => {
      const url = request?.url ?? "";
      if (url.includes("library_hero.jpg")) {
        // 宽图档：直接给图（200 + image/png），让回退链在这里**确定性地**停下。
        void page
          .send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "image/png" }],
            body: PIXEL_PNG,
          })
          .catch(() => {});
        return;
      }
      setTimeout(() => {
        void page.send("Fetch.failRequest", { requestId, errorReason: "Failed" }).catch(() => {});
      }, 200);
    });
    await page.goto(URL);
    await page.wait(4000);
    /*
     * 等图：这一步每张卡都要先失败两次（竖封面 + 重试）再去拉宽图，12 张卡一起走 ——
     * CDN 慢的时候固定等 9 秒会抓到「还有 3 张在路上」的假红（本机真踩过：9/12）。
     * 所以轮询到「全部有图」为止，最多 25 秒；到点还没齐就按实际数量报。
     */
    const readCovers = `
      const items = [...document.querySelectorAll('.k1-item')];
      return items.map((item) => {
        const img = item.querySelector('img.k1-cover');
        return {
          有图: !!img && img.naturalWidth > 0,
          宽图: !!img && img.src.includes('library_hero'),
          占位: !!item.querySelector('.game-cover-fallback'),
        };
      });
    `;
    let covers = await page.eval(readCovers);
    for (let tries = 0; tries < 42 && covers.some((c) => !c.有图 && !c.占位); tries++) {
      await page.wait(500);
      covers = await page.eval(readCovers);
    }
    /*
     * 断言的是**回退链走到了哪**，不是「12 张图都下载完了」：
     * CDN 慢的时候（本机见过 6/12）最后那几张还在路上，那是网络不是逻辑，不该判红。
     * 真正要钉住的是两条：① 每张卡的 `src` 都已经是宽图；② 一张都没掉到占位（掉占位说明链走完了还没图）。
     * 真下不下来的情况这里也不会漏：宽图 404 → 下一档 header 也被挡住 → `failed` → 占位。
     */
    const withArt = covers.filter((c) => c.有图).length;
    const onHero = covers.filter((c) => c.宽图).length;
    const placeholder = covers.filter((c) => c.占位).length;
    note(
      covers.length > 0 && onHero === covers.length && placeholder === 0,
      `封面 404 时卡片退到宽图（${onHero}/${covers.length} 张的 src 是 library_hero.jpg，占位 ${placeholder} 张；宽图由探针自己喂，不看 CDN 脸色）`,
    );
    await page.send("Fetch.disable");
  } finally {
    await page.close();
  }
};

/**
 * 英文一遍（改造包 §16 的验收项「中英双语切换后无截断、无溢出」）：
 * 把 localStorage 里的语言设成 en、刷新，再把七个页签走一遍 —— 查三件事：
 *   ① 整页没有横向溢出（scrollWidth > 视口宽）；
 *   ② 交互控件上的字没被截（scrollWidth > clientWidth，容 2px 的亚像素零头）；
 *   ③ **顶栏那 9 个页签在英文下也全须全尾**：都待在条盒里（Community / Downloads 最长，
 *      页签条装不下时会溢到时钟和电量上 —— 这条是 2026-10-11 菜单搬上顶栏时新加的）。
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
      for (const [index, name] of ["首页", "游戏库", "软件库", "下载", "文件", "工具箱", "模拟器"].entries()) {
        // 英文界面上页签文字是 Home / Library…，所以按**位置**点（顺序固定）而不是按文字找
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
          // 顶栏页签：英文标签最长（Downloads / Emulators / Community），装不下会从条盒里溢到
          // 时钟或电量上 —— 所以这里逐项量盒子，而不是只看整页 scrollWidth（外壳 overflow 是 hidden，
          // 溢出不会变成页面滚动条，只看 scrollWidth 永远发现不了）。
          const nav = document.querySelector('.nav-items');
          const navBox = nav.getBoundingClientRect();
          const tabs = [...document.querySelectorAll('.nav-item')];
          const navOutside = tabs.filter((t) => {
            const r = t.getBoundingClientRect();
            return r.left < navBox.left - 0.5 || r.right > navBox.right + 0.5;
          }).length;
          const sel = '.nav-item, .k7-tool, .k7-search, .k7-sort, .k7-chip, .k7-crumb, .k7-place, .k2-btn, .k1-btn, .hint-pair, .k4-selfcheck, .k4-card-action, .k4-primary, .k4-row-item, .library-tool';
          const clipped = [...document.querySelectorAll(sel)]
            .filter((el) => el.offsetParent !== null && el.scrollWidth > el.clientWidth + 2)
            .map((el) => (el.className || '').split(' ')[0] + '|' + (el.textContent || '').trim().slice(0, 16));
          return { overflow, navOutside, tabs: tabs.length, clipped: clipped.slice(0, 5), n: clipped.length, lang: document.documentElement.lang };
        `);
        const label = `${name}（英文 lang=${en.lang}）`;
        note(!en.overflow, `${label}：整页没有横向溢出`);
        note(en.n === 0, `${label}：控件上的字都没被截${en.n ? "（" + en.clipped.join("、") + "）" : ""}`);
        note(en.navOutside === 0 && en.tabs === 9,
          `${label}：顶栏 9 个页签都在条盒里（越界 ${en.navOutside} 个 / 共 ${en.tabs} 个）`);
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
console.log("\n=== 七个页签的焦点环 / 焦点规矩巡检 ===");
await scanTabs();
await englishPass();

console.log(problems.length ? `\n❌ ${problems.length} 项没过：\n  - ${problems.join("\n  - ")}` : "\n✅ 全部通过");
process.exit(problems.length ? 1 : 0);

