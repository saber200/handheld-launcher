#!/usr/bin/env node
/*
 * Tauri 命令权限审计 —— 挡住「功能悄悄不工作」这一类问题。
 *
 * 为什么要有这个脚本：本仓库在 `src-tauri/permissions/*.toml` 里定义了自己的 ACL 清单，
 * 而 Tauri v2 只要发现「应用自己定义了 ACL」（tauri-2.12.0/src/webview/mod.rs 里那个
 * `has_app_acl_manifest` 分支），就会对**应用自己的命令**也逐条查权限，查不到直接
 * `Command xxx not allowed by ACL` 拒掉。前端那边 `.catch()` 一吞，界面上只剩
 * 「读不出来 / 一直待接入 / 那个按钮没反应」—— 编译器、tsc、clippy 一个都不会说话，
 * 本机（macOS）更是连跑都跑不到。v0.1.62 真机上「存储空间一直待接入」就是这条：
 * `system_storage` 命令在、前端也在调，但没人给它 allow。
 *
 * 所以三件事必须同时成立，缺一条就是运行期被拒：
 *   1. 命令注册进了 `src-tauri/src/lib.rs` 的 `invoke_handler!`（否则 "command not found"）；
 *   2. `src-tauri/permissions/*.toml` 里有一条 `commands.allow` 包含它；
 *   3. 那条 permission 的 identifier 被 `src-tauri/capabilities/*.json` 引用（否则没进 ACL）。
 *
 * 用法：node scripts/audit-acl.mjs
 *
 * 已知的「字面量看不出来」的调用只有一处：`src/library/useLocalLibrary.ts` 的
 * `useScanned(command)` —— 它只被传 `"scan_games"` / `"scan_apps"`，而这两个名字在同一个
 * 文件里以字面量出现在 `readScanCache("scan_games")` 等处，所以照样扫得到。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Windows 上必须走 fileURLToPath（URL.pathname 会给出 "/C:/..." 这种带前导斜杠的路径）。
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const full = `${dir}/${name.name}`;
    if (name.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 前端真正会 invoke 的命令名（只看字符串字面量那一批）。 */
function invokedCommands() {
  const found = new Map();
  for (const file of walk("src").filter((p) => /\.(ts|tsx)$/.test(p))) {
    const text = read(file);
    const re = /invoke(?:<[^>]*>)?\(\s*"([A-Za-z0-9_]+)"/g;
    let m;
    while ((m = re.exec(text))) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push(file);
    }
  }
  return found;
}

/**
 * `invoke_handler!` 里注册的命令名。
 *
 * 按行读、读到缩进的 `])` 收工：早先按 `,` 切会把**最后一条**（后面没有逗号）漏掉，
 * 于是脚本反过来冤枉它「没注册」—— 审计工具自己先得准。
 */
function registeredCommands() {
  const lines = read("src-tauri/src/lib.rs").split("\n");
  const start = lines.findIndex((line) => line.includes("invoke_handler"));
  if (start < 0) throw new Error("src-tauri/src/lib.rs 里找不到 invoke_handler");
  const names = new Set();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "])") break;
    // 去掉行尾注释再判断：那一串里有中文注释，直接按标识符扫会把汉字也当成命令名。
    const code = line.replace(/\/\/.*$/, "").trim().replace(/,$/, "");
    if (/^[A-Za-z0-9_:]+$/.test(code)) names.add(code.split("::").pop());
  }
  return names;
}

/** 权限文件：permission id → 它 allow 的命令。 */
function permissions() {
  const byCommand = new Map();
  const ids = new Set();
  for (const file of walk("src-tauri/permissions").filter((p) => p.endsWith(".toml"))) {
    for (const chunk of read(file).split("[[permission]]").slice(1)) {
      const id = chunk.match(/identifier\s*=\s*"([^"]+)"/)?.[1];
      if (!id) continue;
      ids.add(id);
      const allow = chunk.match(/commands\.allow\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
      for (const m of allow.matchAll(/"([A-Za-z0-9_]+)"/g)) {
        if (!byCommand.has(m[1])) byCommand.set(m[1], []);
        byCommand.get(m[1]).push({ id, file });
      }
    }
  }
  return { byCommand, ids };
}

/** capabilities/*.json 里引用的 permission 标识。 */
function capabilityRefs() {
  const refs = new Set();
  for (const file of walk("src-tauri/capabilities").filter((p) => p.endsWith(".json"))) {
    const json = JSON.parse(read(file));
    for (const entry of json.permissions ?? []) {
      const id = typeof entry === "string" ? entry : entry.identifier;
      if (id) refs.add(id);
    }
  }
  return refs;
}

const invoked = invokedCommands();
const registered = registeredCommands();
const { byCommand, ids: permissionIds } = permissions();
const refs = capabilityRefs();

const blocking = [];

for (const [command, sites] of invoked) {
  const where = [...new Set(sites)].join(", ");
  if (!registered.has(command)) {
    blocking.push(`${command}（${where}）：没注册进 lib.rs 的 invoke_handler!，调用会报 command not found`);
    continue;
  }
  const owners = byCommand.get(command);
  if (!owners) {
    blocking.push(`${command}（${where}）：没有任何 permission 允许它 —— 运行期会被 ACL 拒掉`);
    continue;
  }
  if (!owners.some((o) => refs.has(o.id))) {
    blocking.push(
      `${command}（${where}）：${owners.map((o) => o.id).join(" / ")} 没被 capabilities 引用，等于没进 ACL`,
    );
  }
}

// 权限文件里引用了但没定义的（拼错 identifier 时 Tauri 构建期就会炸，这里提前说清楚）。
for (const id of refs) {
  if (id.startsWith("allow-") && !permissionIds.has(id)) {
    blocking.push(`capabilities 引用了 ${id}，但没有任何权限文件定义它`);
  }
}

// 定义了却没人引用的 permission：先只报告（可能是留给小组件 / 下一版用的）。
const pending = [...permissionIds]
  .filter((id) => id.startsWith("allow-") && !refs.has(id))
  .map((id) => `permissions 里定义了 ${id}，但 capabilities 没引用它（等于没生效）`);

const report = (title, list) => {
  console.log(`\n=== ${title} ===`);
  if (!list.length) return console.log("✅ 0 处");
  for (const item of list) console.log(`    ${item}`);
};

console.log(`前端 invoke 的命令 ${invoked.size} 个 / 后端注册 ${registered.size} 个 / 权限 ${permissionIds.size} 条`);
report("必须修（漏注册 / 漏 allow / 没进 ACL）", blocking);
report("待确认（定义了没人用的 permission）", pending);

if (blocking.length) {
  console.error(`\n❌ ${blocking.length} 处必须修 —— 这些命令在真机上都会被拒，本机测不出来`);
  process.exit(1);
}
console.log("\n✅ 通过");
