#!/usr/bin/env node
/*
 * 「掌机真的会装吗」—— 拿发布出去的安装包与签名，用**应用里写死的那把公钥**验一遍（2026-10-15 加）。
 *
 * 为什么值得单独一个脚本：这一版掌机上一直报 `The signature verification failed`，真因是
 * **Gitee 镜像上的安装包和指针里的签名不是同一份** —— 重推 tag 之后 GitHub 重新构建、附件被换掉，
 * 而镜像那一步的口径是「同名附件已存在就跳过上传」，于是包还是上一次构建的、签名已经换成新的，
 * 掌机下完包在最后一步拒装。当时 CI 全绿：它只确认了「传上去了、下载地址返回 MZ 头」，
 * **从没验过"这份字节是不是那把钥匙签的"**。这个脚本就是那条缺失的断言。
 *
 * 与 tauri-plugin-updater 用的 `minisign_verify` **逐字节等价**（本机对着同一份 `latest.json`
 * 与同一个包与 Rust 那套核过：好包 PASS、镜像上的旧包 FAIL）：
 *   - 预哈希模式（算法 `ED`）：Ed25519 签的是 **blake2b-512(整个文件)**；
 *   - 另有「全局签名」：Ed25519 签 `64 字节主签名 ‖ 去掉前缀的 trusted comment`，两个都要过；
 *   - 公钥 key id 与签名 key id 必须一致（不一致 = 换了钥匙，掌机也拒装）。
 *
 * 用法（不编译 Rust、不装依赖，Node 内置 crypto 就够）：
 *   node scripts/verify-update.mjs <安装包> <签名：.sig 文件 | latest.json | 签名串> [--pubkey <pubkey 值 | tauri.conf.json>]
 * 退出码 0 = 掌机装得上；非 0 = 就这么发出去，掌机会报签名不符。
 */
import { createHash, createPublicKey, verify as ed25519Verify } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function die(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let pubkeySource = null;
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--pubkey") {
    pubkeySource = argv[++i];
  } else {
    positional.push(argv[i]);
  }
}
const [filePath, signatureSource] = positional;
if (!filePath || !signatureSource) {
  die("用法：node scripts/verify-update.mjs <安装包> <签名：.sig 文件 | latest.json | 签名串> [--pubkey <值 | tauri.conf.json>]");
}

/* ── ① 公钥：默认取应用里写死的那把（这是"掌机会不会装"的唯一判据） ───────────── */
/** 公钥可以给三种写法：tauri.conf.json 路径、pubkey 的 base64 串、minisign.pub 原文。 */
function pubkeyText(source) {
  if (!source) {
    const conf = JSON.parse(readFileSync(resolve(repoRoot, "src-tauri/tauri.conf.json"), "utf8"));
    return Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf8");
  }
  let text = source;
  try {
    // 传的是文件：要么是 tauri.conf.json（里面是 base64 的 pubkey），要么是 minisign.pub 原文。
    const raw = readFileSync(source, "utf8");
    text = raw.trim().startsWith("{")
      ? Buffer.from(JSON.parse(raw).plugins.updater.pubkey, "base64").toString("utf8")
      : raw;
  } catch {
    // 不是文件路径，就当成 base64 串（应用配置里就是这种形态）。
    text = Buffer.from(source, "base64").toString("utf8");
  }
  return text;
}

const pubText = pubkeyText(pubkeySource);
if (!pubText.includes("minisign public key")) {
  die(`公钥解不开（应该形如 "untrusted comment: minisign public key: …"）：${pubText.slice(0, 60)}`);
}
const pubBlob = Buffer.from(pubText.trim().split("\n")[1], "base64");
if (pubBlob.length !== 42 || pubBlob.subarray(0, 2).toString() !== "Ed") {
  die(`公钥不是合法的 minisign 公钥（${pubBlob.length} 字节）`);
}
const keyId = pubBlob.subarray(2, 10).toString("hex");
const publicKey = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubBlob.subarray(10, 42)]),
  format: "der",
  type: "spki",
});

/* ── ② 签名：给 .sig 文件、latest.json、或直接给串都行 ─────────────────────── */
function signatureText(source) {
  let raw = source;
  try {
    raw = readFileSync(source, "utf8");
  } catch {
    // 不是文件，就是签名串本身。
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    // latest.json：取平台里那一项（NSIS 优先，跟 updater 挑平台的口径一致）。
    const platforms = JSON.parse(trimmed).platforms ?? {};
    const entry = platforms["windows-x86_64-nsis"] ?? platforms["windows-x86_64"] ?? Object.values(platforms)[0];
    if (!entry?.signature) die("latest.json 里没有 platforms[*].signature");
    raw = entry.signature;
  }
  return Buffer.from(raw.trim(), "base64").toString("utf8");
}

const lines = signatureText(signatureSource).split("\n");
const sigBlob = Buffer.from(lines[1] ?? "", "base64");
const globalSignature = Buffer.from(lines[3] ?? "", "base64");
if (sigBlob.length !== 74 || globalSignature.length !== 64) {
  die(`签名不是 minisign 的 .sig 格式（主签名 ${sigBlob.length} 字节、全局签名 ${globalSignature.length} 字节）`);
}
if (!(lines[2] ?? "").startsWith("trusted comment: ")) die("签名缺 trusted comment 那一行");
const trustedComment = lines[2].slice("trusted comment: ".length);
const sigKeyId = sigBlob.subarray(2, 10).toString("hex");
if (sigKeyId !== keyId) {
  die(`签名 key id ${sigKeyId.toUpperCase()} ≠ 应用公钥 key id ${keyId.toUpperCase()} —— 这份包是另一把私钥签的，掌机一定拒装`);
}
const prehashed = sigBlob.subarray(0, 2).toString() === "ED";

/* ── ③ 逐字节等价于 minisign_verify：主签名 + 全局签名都要过 ─────────────────── */
const blake2b = createHash("blake2b512");
const sha256 = createHash("sha256");
for await (const chunk of createReadStream(filePath)) {
  blake2b.update(chunk);
  sha256.update(chunk);
}
const payload = prehashed ? blake2b.digest() : readFileSync(filePath);
const okMain = ed25519Verify(null, payload, publicKey, sigBlob.subarray(10, 74));
const okGlobal = ed25519Verify(
  null,
  Buffer.concat([sigBlob.subarray(10, 74), Buffer.from(trustedComment, "utf8")]),
  publicKey,
  globalSignature,
);

const size = statSync(filePath).size;
console.log(`  安装包：${filePath}`);
console.log(`  大小：${size} 字节，sha256 ${sha256.digest("hex")}`);
console.log(`  key id：${keyId.toUpperCase()}（应用公钥 = 签名）`);
console.log(`  签名注释：${trustedComment}`);

if (!okMain || !okGlobal) {
  die(
    `签名验不过（主签名 ${okMain ? "过" : "不过"} / 全局签名 ${okGlobal ? "过" : "不过"}）—— ` +
      `掌机装这一步会报 "The signature verification failed"。多半是这份字节和签名不是同一次构建的` +
      `（镜像站上同名旧附件顶替、或包里被改过一个字节）。`,
  );
}
console.log("✅ 签名通过：掌机会正常装上这一份（与 tauri-plugin-updater 的校验口径一致）。");
