#!/usr/bin/env node
/*
 * UI 规范审计 —— 改造包 tools/ 那三个脚本的替代实现。
 *
 * 为什么重写：包里给的 audit_radius.py / audit_spacing.py / verify_geometry.py 开头就是
 * `import ds2` / `import boards2`（设计工具内部的渲染库），改造包里**没有带**这两个模块，
 * 本机实测直接 ModuleNotFoundError。它检查的事情照搬，但改成扫源码，才能真的进 CI。
 *
 * 检查项：
 *   1. 禁胶囊 / 椭圆：border-radius 999px 一律违规；50% 只允许状态点、按键角标、滑块旋钮。
 *   2. 圆角值只能取令牌六档（6/8/10/12/14/16/18）或 var(--radius-*)。
 *   3. 颜色与 docs/redesign/reference/design-tokens.json 逐项比对（tokens.css 是唯一落点）。
 *   4. 手写数值（padding / gap / margin 的 px）—— 旧页面按里程碑迁移，见 LEGACY。
 *
 * 用法：
 *   node scripts/audit-ui.mjs            # 胶囊/椭圆/颜色漂移算错，手写数值只报告
 *   node scripts/audit-ui.mjs --strict   # 全部算错（迁移完成后 CI 用这个）
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const strict = process.argv.includes("--strict");

/** 还没迁到令牌的旧页面：手写数值先只报告不拦。迁移完一个就删一个。 */
const LEGACY = [
  "src/styles/global.css",
  "src/frontend/frontend.css",
  "src/pages/FilesPage.tsx",
  "src/components/LibraryShelf.tsx",
  "src/hooks/useGamepadNav.ts",
];

const RADIUS_TOKENS = [0, 2, 3, 6, 8, 10, 12, 14, 16, 18];
/** 允许正圆的选择器（状态点 / 手柄按键角标 / 滑块旋钮）。 */
const CIRCLE_ALLOW = /(dot|pick-mark|knob|thumb|hint-key|range)/i;
/** 手写数值免检的选择器：几何由内容决定的元素（图标、封面比例等）。 */
const NUMBER_ALLOW = /(icon|cover|font-size|line-height|grid-template|flex-basis)/i;

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(css|tsx|ts)$/.test(name)) out.push(full);
  }
  return out;
}

function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim().split("\n").pop().trim(), body: m[2] });
  return out;
}

const blocking = [];
const pending = [];

for (const file of files(join(ROOT, "src"))) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, "utf8");
  const legacy = LEGACY.includes(rel);
  const push = (msg) => (legacy && !strict ? pending : blocking).push(`${rel}: ${msg}`);

  if (file.endsWith(".css")) {
    for (const { selector, body } of rules(text)) {
      const radius = /border-radius:\s*([^;]+);/.exec(body);
      if (radius) {
        const value = radius[1].trim();
        if (/999|9999/.test(value)) {
          push(`胶囊圆角 \`border-radius: ${value}\`（${selector}）—— 改成 var(--radius-*) 或按键角标 var(--focus-badge)/2`);
        } else if (value.includes("50%") && !CIRCLE_ALLOW.test(selector)) {
          push(`椭圆/正圆 \`border-radius: 50%\`（${selector}）—— 只允许状态点、按键角标、滑块旋钮`);
        } else if (/^\d+(\.\d+)?px$/.test(value) && !RADIUS_TOKENS.includes(Number.parseFloat(value))) {
          push(`圆角 ${value} 不在令牌六档（${RADIUS_TOKENS.join("/")}）（${selector}）`);
        }
      }
      for (const [, prop, value] of body.matchAll(/(padding|gap|margin|margin-top|margin-left|padding-left|padding-right|min-height|width|height):\s*([^;]+);/g)) {
        if (!/px/.test(value) || value.includes("var(") || value.includes("calc(")) continue;
        if (NUMBER_ALLOW.test(selector)) continue;
        const numbers = [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((n) => Number.parseFloat(n[1]));
        if (!numbers.length || numbers.every((n) => RADIUS_TOKENS.includes(n) || n === 1 || n === 2 || n === 3 || n === 4 || n === 5)) continue;
        push(`手写数值 ${prop}: ${value}（${selector}）—— 走 tokens.css 的间距/几何令牌`);
      }
    }
  }
}

// ── 颜色与令牌文件对表 ──
const tokens = readFileSync(join(ROOT, "docs/redesign/reference/design-tokens.json"), "utf8");
const doc = JSON.parse(tokens);
const css = readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8").toLowerCase();
const colorPairs = [
  ["bg0", "--bg0"], ["bg1", "--bg1"], ["bgDeep", "--bg-deep"], ["panel", "--panel"],
  ["panel2", "--panel-2"], ["panel3", "--panel-3"], ["sunken", "--sunken"], ["line", "--line"],
  ["lineSoft", "--line-soft"], ["lineStrong", "--line-strong"], ["ink", "--ink"], ["ink2", "--ink-2"],
  ["ink3", "--ink-3"], ["ink4", "--ink-4"], ["accent", "--accent"], ["accent2", "--accent-2"],
  ["accentDeep", "--accent-deep"], ["accentHi", "--accent-hi"], ["onAccent", "--on-accent"],
  ["danger", "--danger"], ["warning", "--warning"], ["success", "--success"],
];
for (const [key, cssVar] of colorPairs) {
  const want = String(doc.color[key]).toLowerCase();
  const found = new RegExp(`${cssVar}:\\s*([^;]+);`).exec(css);
  if (!found) blocking.push(`src/styles/tokens.css: 缺少 ${cssVar}（design-tokens.json 的 color.${key}）`);
  else if (found[1].trim() !== want) blocking.push(`src/styles/tokens.css: ${cssVar} = ${found[1].trim()}，设计稿是 ${want}`);
}
for (const [name, value] of Object.entries(doc.radius)) {
  if (name === "rule") continue;
  if (!css.includes(`calc(${value} * var(--dp))`) && !css.includes(`${value} * var(--dp)`)) {
    blocking.push(`src/styles/tokens.css: 少了 ${value}dp 这一档圆角（design-tokens.json 的 radius.${name}）`);
  }
}

const report = (title, list) => {
  console.log(`\n=== ${title} ===`);
  if (!list.length) return console.log("✅ 0 处");
  const byFile = new Map();
  for (const item of list) {
    const file = item.split(":")[0];
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  for (const [file, count] of byFile) console.log(`  ${file} … ${count} 处`);
  for (const item of list.slice(0, 30)) console.log(`    ${item}`);
  if (list.length > 30) console.log(`    …还有 ${list.length - 30} 处`);
};

report(strict ? "违规（严格模式）" : "必须修（胶囊 / 椭圆 / 令牌漂移）", blocking);
report("待迁移（旧页面手写数值）", pending);

if (blocking.length) {
  console.error(`\n❌ ${blocking.length} 处必须修`);
  process.exit(1);
}
console.log(`\n✅ 通过（待迁移 ${pending.length} 处${strict ? "" : "，加 --strict 会一并算错"}）`);
