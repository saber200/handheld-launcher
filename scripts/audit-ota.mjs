#!/usr/bin/env node
/*
 * OTA 配置哨兵（2026-10-12 加）。
 *
 * 为什么值得单独一个脚本：OTA 这条链路上，**几乎所有错误都是静默的** ——
 * 构建照样绿、应用照样起，只是"更新永远查不到"或者"查到了装不上"。已经踩过的两个：
 *   ① tauri-action 的输入名写成 `includeUpdaterJson`（正确是 `uploadUpdaterJson`）：
 *      GitHub 对未知输入只给一句警告、步骤照样成功，于是 `latest.json` 永远不产出；
 *   ② 公钥和 CI 私钥不是同一对：应用能把 `latest.json` 读回来、能下载、然后**在最后一步
 *      以"签名不符"拒绝安装**，报错还只有一句英文。
 * 这两件事本机都能查出来，就不该等发版才发现。
 *
 * 查什么（每条都是"错了也不会红"的地方）：
 *   - `tauri.conf.json`：`createUpdaterArtifacts` 开着、公钥非空且是 minisign 公钥、
 *     endpoint 指向发布物仓库、`windows.installMode` 是合法值；
 *   - `Cargo.toml` / `lib.rs` / capabilities：两个插件装了、注册了、前端有权限；
 *   - CI 工作流：tag 构建发到公开仓、`uploadUpdaterJson` + `uploadUpdaterSignatures` 都开着、
 *     三个密钥/令牌的环境变量都在。
 *
 * 用法：`npm run audit:ota`（pre-commit 也会跑）。
 */
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const read = (rel) => readFileSync(root + rel, "utf8");
const problems = [];
const notes = [];

function check(ok, message) {
  if (ok) notes.push(message);
  else problems.push(message);
}

/* ── ① 应用侧配置 ─────────────────────────────────────────────────────── */
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
check(
  conf.bundle?.createUpdaterArtifacts === true,
  "tauri.conf.json：bundle.createUpdaterArtifacts = true（否则构建不产出 .sig，更新包无法校验）",
);
const updater = conf.plugins?.updater ?? {};
let pubKeyId = "";
try {
  const pubText = Buffer.from(updater.pubkey ?? "", "base64").toString("utf8");
  const blob = Buffer.from(pubText.trim().split("\n")[1] ?? "", "base64");
  pubKeyId = blob.subarray(2, 10).toString("hex").toUpperCase();
  check(
    pubText.includes("minisign public key") && blob.length >= 40,
    `tauri.conf.json：公钥是合法的 minisign 公钥（key id ${pubKeyId}）`,
  );
} catch {
  check(false, "tauri.conf.json：plugins.updater.pubkey 解不开 —— OTA 一定装不上");
}
const endpoints = updater.endpoints ?? [];
check(
  endpoints.length > 0 && endpoints.every((url) => /^https:\/\//.test(url)),
  `tauri.conf.json：更新地址是 https（${endpoints[0] ?? "空"}）`,
);
check(
  endpoints.some((url) => url.includes("fantasyhub-releases")),
  "tauri.conf.json：更新地址指向公开的发布物仓库（私有仓要 token，应用里不能带 token）",
);
check(
  ["quiet", "passive", "basicUi"].includes(updater.windows?.installMode ?? "passive"),
  `tauri.conf.json：Windows 安装模式合法（${updater.windows?.installMode ?? "默认 passive"}）`,
);

/* ── ② 后端与权限 ─────────────────────────────────────────────────────── */
const cargo = read("src-tauri/Cargo.toml");
check(
  /tauri-plugin-updater\s*=/.test(cargo) && /tauri-plugin-process\s*=/.test(cargo),
  "Cargo.toml：updater 与 process 两个插件都在依赖里",
);
const lib = read("src-tauri/src/lib.rs");
check(
  lib.includes("tauri_plugin_updater::Builder") && lib.includes("tauri_plugin_process::init"),
  "lib.rs：两个插件都注册进 builder 了",
);
const caps = read("src-tauri/capabilities/default.json");
check(
  caps.includes('"updater:default"') && caps.includes('"process:allow-restart"'),
  "capabilities：前端有 updater:default 与 process:allow-restart（少了会「点了没反应」）",
);
const pkg = JSON.parse(read("package.json"));
check(
  pkg.dependencies?.["@tauri-apps/plugin-updater"] && pkg.dependencies?.["@tauri-apps/plugin-process"],
  "package.json：两个前端包都在依赖里",
);

/* ── ③ CI ─────────────────────────────────────────────────────────────── */
/*
 * 先**把注释行去掉**再查：工作流里那些"⚠️ 别写成 uploadUpdaterJson"的说明本身含有旧名字，
 * 不剥注释的话，哨兵会被自己的注释绊倒（2026-10-12 真踩到）。
 */
const wf = read(".github/workflows/build-windows.yml")
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");
check(wf.includes("tauri-apps/tauri-action"), "CI：用 tauri-action 构建与发布");
// ⚠️ 输入名要跟**实际用的 ref**（`@v0`）对齐：v0 是 `includeUpdaterJson`，
// `uploadUpdaterJson` 只在 `dev` 分支上（2026-10-12 v0.1.81 那次就是写错名字，
// GitHub 只给一句 "Unexpected input(s)" 的警告、步骤照样绿，开关实际没生效）。
check(
  /includeUpdaterJson:\s*true/.test(wf) && !/uploadUpdaterJson/.test(wf),
  "CI：includeUpdaterJson = true（v0 的输入名；写成 dev 分支的 uploadUpdaterJson 只会警告不生效）",
);
// 跨仓库发布必须给 releaseCommitish：公开仓没有我们私有仓的 commit，
// 不给它，建 release 时会报 "tag_name is not a valid tag"（v0.1.81 的失败原因）。
check(
  /releaseCommitish:\s*\$\{\{/.test(wf),
  "CI：给了 releaseCommitish（跨仓库发布建 tag 要用公开仓自己的分支）",
);
check(
  /owner:\s*\$\{\{/.test(wf) && /repo:\s*\$\{\{/.test(wf) && wf.includes("fantasyhub-releases"),
  "CI：tag 构建发到公开的发布物仓库（owner/repo 跟着 tag 切）",
);
for (const key of [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "RELEASE_TOKEN",
]) {
  check(wf.includes(key), `CI：用到了 ${key}`);
}
check(
  /GITHUB_TOKEN:\s*\$\{\{[^}]*\bref_type\b/.test(wf),
  "CI：GITHUB_TOKEN 按构建类型切（tag → RELEASE_TOKEN，开发构建 → github.token）",
);

/* ── ④ 最坏的一种事故：签名私钥被提交进仓库 ───────────────────────────── */
/*
 * 私钥泄了 = 别人能签出**你的机器愿意装**的包（那等于把掌机交出去）。它本该只存在两个地方：
 * CI 的 secret、以及你自己的密码管理器；仓库里只该有公钥。
 * 这里只扫 git 跟踪的文件（毫秒级，不碰 node_modules / target）—— 真出事的场景就是"有人把它加进了提交"。
 */
import { execFileSync } from "node:child_process";
let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch {
  notes.push("（不在 git 仓库里，跳过私钥扫描）");
}
const KEY_HEAD = "untrusted comment: rsign encrypted secret key";
const leaked = [];
for (const rel of tracked) {
  // 只读小文本文件：私钥本体是 300 多字节的一行，别把大文件读进内存。
  if (/\.(png|jpg|jpeg|webp|ico|gif|exe|dll|zip|7z|bin|lock)$/i.test(rel)) continue;
  let text = "";
  try {
    text = read(rel).slice(0, 4096);
  } catch {
    continue;
  }
  if (text.includes(KEY_HEAD)) leaked.push(rel);
}
check(
  leaked.length === 0,
  leaked.length === 0
    ? "仓库里没有任何更新包私钥（只该有公钥）"
    : `⚠️ 仓库里发现了更新包私钥：${leaked.join("、")} —— 立刻删掉、**换一对新钥匙**，并让所有机器手动装一次新版`,
);

/* ── 结果 ─────────────────────────────────────────────────────────────── */
for (const line of notes) console.log(`  ✅ ${line}`);
if (problems.length > 0) {
  console.log("");
  for (const line of problems) console.log(`  ❌ ${line}`);
  console.log(`\n❌ ${problems.length} 处 OTA 配置不对 —— 每一条都会静默地让更新失效，先修再发版。`);
  process.exit(1);
}
console.log(`\n✅ OTA 配置通过（公钥 key id ${pubKeyId}；本地无法核对私钥，私钥只在 CI secret 里）。`);
