#!/usr/bin/env node
/*
 * 「掌机视角」的线上 OTA 审计 —— 从真实更新地址把指针与安装包拉下来，代替掌机走一遍。
 *
 * 与 scripts/audit-ota.mjs 的分工：那个查的是「仓库里的 OTA 配置对不对」；本脚本查的是
 * **线上真正发出去的东西对不对** —— 掌机点「检查更新」时看到的就是这条链路：
 *   ① 读 src-tauri/tauri.conf.json 的 plugins.updater.endpoints（应用按这个顺序试）；
 *   ② 逐个源拉 latest.json（30 秒超时、最多重试 3 次），拿到 version 与 Windows 安装包的 url/signature；
 *   ③ 所有能解析的源，version 必须一致（不一致 = 有的机器会永远停在旧版）；
 *   ④ 用非 github.com 的那个源（Gitee，应用里排第一）真下完整安装包；
 *   ⑤ 确认下到的字节以 MZ 开头（不是 HTML 错误页）；
 *   ⑥ 交给 scripts/verify-update.mjs 用应用里写死的公钥验签名（本脚本不自研验签）；
 *   ⑦ 对 GitHub 的**安装包**地址只发 HEAD，拿 content-length 与 Gitee 实下字节数比体积
 *      （绝不发 GET，避免双份 72 MB）。
 * 逐项打印 ✅/⚠️/❌ 加中文结论；⚠️ 只是提醒、不影响退出码，❌ 才是掌机真会翻车的地方。
 *
 * 用法：node scripts/audit-ota-live.mjs
 * 退出码 0 = 从掌机视角看线上 OTA 链路是通的；非 0 = 有 ❌，先修发布物再发版。
 */
import {
  closeSync,
  createWriteStream,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { Readable, pipeline } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const passed = [];
const warned = [];
const failed = [];

const tempFiles = [];
/** 结束时删掉本脚本落盘的临时文件；删不掉也不影响退出码。 */
function cleanup() {
  for (const file of tempFiles) {
    try {
      unlinkSync(file);
    } catch {
      // 兜住即可。
    }
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 带超时与重试的 fetch：网络抖动时多试几次，仍失败把最后一次错误抛出。 */
async function fetchWithRetry(url, timeout, attempts, options = {}) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (i < attempts) await sleep(2000);
    }
  }
  throw lastError;
}

function hostOf(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "";
  }
}

/* ── ① 应用里配置的更新地址（顺序就是掌机试的顺序） ───────────────────── */
const conf = JSON.parse(readFileSync(resolve(repoRoot, "src-tauri/tauri.conf.json"), "utf8"));
const endpoints = conf?.plugins?.updater?.endpoints ?? [];
if (endpoints.length === 0) {
  console.log("  ❌ tauri.conf.json：plugins.updater.endpoints 是空的 —— 掌机查不到任何更新地址。");
  process.exit(1);
}

/* ── ② 逐个源拉 latest.json，落盘并解析出指针 ─────────────────────────── */
const pointers = [];
for (const endpoint of endpoints) {
  const host = hostOf(endpoint) || "unknown";
  const pointerFile = resolve(tmpdir(), `fh-ota-live-${host}.json`);
  try {
    const response = await fetchWithRetry(endpoint, 30000, 3);
    const text = await response.text();
    writeFileSync(pointerFile, text);
    tempFiles.push(pointerFile);
    const pointer = JSON.parse(text);
    const platform = pointer.platforms?.["windows-x86_64-nsis"] ?? pointer.platforms?.["windows-x86_64"];
    if (!pointer.version) throw new Error("latest.json 里没有 version");
    if (!platform?.url || !platform?.signature) {
      throw new Error('latest.json 里没有 platforms["windows-x86_64-nsis"|"windows-x86_64"] 的 url/signature');
    }
    pointers.push({
      endpoint,
      host,
      version: pointer.version,
      url: platform.url,
      signature: platform.signature,
      pointerFile,
    });
    passed.push(`${host}：latest.json 拉到并解析成功（version ${pointer.version}）`);
  } catch (error) {
    failed.push(`${host}：latest.json 拉取/解析失败 —— ${error.message}`);
  }
}

/* ── ③ 各源指针版本必须完全一致 ───────────────────────────────────────── */
if (pointers.length > 1) {
  const versions = [...new Set(pointers.map((pointer) => pointer.version))];
  if (versions.length > 1) {
    failed.push(
      `各源 latest.json 版本不一致：${pointers.map((pointer) => `${pointer.host}=${pointer.version}`).join("、")} —— 有的掌机会永远停在旧版。`,
    );
  } else {
    passed.push(`各源 latest.json 版本一致（${versions[0]}）`);
  }
}

/* ── ④-⑦ Gitee 实下 + MZ + 验签 + 与 GitHub 比体积 ────────────────────── */
const mirrorEndpoint = endpoints.find((endpoint) => {
  const host = hostOf(endpoint);
  return host && host !== "github.com";
});
const mirror = pointers.find((pointer) => pointer.endpoint === mirrorEndpoint);
const github = pointers.find((pointer) => hostOf(pointer.endpoint) === "github.com");

if (!mirrorEndpoint) {
  warned.push("没有非 github.com 的更新源（Gitee 镜像）—— 跳过 ④-⑦（下载、MZ、验签、体积对比）。");
} else if (!mirror) {
  warned.push("Gitee 源在 ② 没解析出指针（已记 ❌）—— 跳过 ④-⑦。");
} else {
  const installer = resolve(tmpdir(), `fh-ota-live-${mirror.host}.exe`);
  let mirrorSize = null;

  try {
    const response = await fetchWithRetry(mirror.url, 600000, 3);
    await new Promise((done, fail) => {
      pipeline(Readable.fromWeb(response.body), createWriteStream(installer), (error) =>
        error ? fail(error) : done(),
      );
    });
    tempFiles.push(installer);
    mirrorSize = statSync(installer).size;
    passed.push(`Gitee 安装包下载完成：${mirrorSize} 字节`);
  } catch (error) {
    failed.push(`Gitee 安装包下载失败 —— ${error.message}`);
  }

  if (mirrorSize === null) {
    warned.push("⑤⑥ 跳过：Gitee 安装包没下下来（④ 已记 ❌）。");
  } else {
    /* ⑤ 头两个字节必须是 MZ */
    const head = Buffer.alloc(2);
    let readBytes = 0;
    const fd = openSync(installer, "r");
    try {
      readBytes = readSync(fd, head, 0, 2, 0);
    } finally {
      closeSync(fd);
    }
    if (readBytes === 2 && head.toString("latin1") === "MZ") {
      passed.push("Gitee 安装包以 MZ 开头（是 Windows 可执行文件，不是错误页）");
    } else {
      failed.push(`Gitee 安装包开头不是 MZ（只读到 ${readBytes} 字节）—— 下到的多半是 HTML 错误页。`);
    }

    /* ⑥ 验签：唯一口径是 scripts/verify-update.mjs，本脚本不自研验签 */
    const verifyScript = resolve(repoRoot, "scripts/verify-update.mjs");
    const verify = spawnSync(process.execPath, [verifyScript, installer, mirror.pointerFile], {
      encoding: "utf8",
    });
    if (verify.status === 0) {
      passed.push("验签通过：Gitee 上的包与指针里的签名是同一份（掌机会装）。");
    } else {
      const tail = `${verify.stdout ?? ""}\n${verify.stderr ?? ""}`
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-3)
        .join(" / ");
      failed.push(`验签失败（scripts/verify-update.mjs 退出码 ${verify.status}）—— ${tail}`);
    }
  }

  /* ⑦ 体积对比：只对 GitHub 的安装包地址发 HEAD，绝不下 GET */
  if (!github) {
    warned.push("⑦ 体积对比跳过：GitHub 指针在 ② 已失败，拿不到 content-length（不计失败）。");
  } else if (mirrorSize === null) {
    warned.push("⑦ 体积对比跳过：没有 ④ 的实际字节数可比（不计失败）。");
  } else {
    try {
      const response = await fetch(github.url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      const header = response.headers.get("content-length");
      if (header !== null && Number(header) === mirrorSize) {
        passed.push(`体积一致：GitHub content-length ${header} 字节 == Gitee 实下 ${mirrorSize} 字节`);
      } else {
        warned.push(
          `体积不一致：GitHub content-length ${header ?? "（拿不到）"} vs Gitee 实下 ${mirrorSize} 字节 —— 两个源可能不是同一次构建。`,
        );
      }
    } catch (error) {
      warned.push(`⑦ 体积对比拿不到 GitHub 的响应头 —— ${error.message}（不计失败）。`);
    }
  }
}

/* ── ⑧ 结论与退出码 ───────────────────────────────────────────────────── */
for (const line of passed) console.log(`  ✅ ${line}`);
for (const line of warned) console.log(`  ⚠️ ${line}`);
if (failed.length > 0) {
  console.log("");
  for (const line of failed) console.log(`  ❌ ${line}`);
  console.log(`\n❌ 线上 OTA 审计发现 ${failed.length} 处问题 —— 从掌机视角看，更新会在这些地方翻车。`);
  cleanup();
  process.exit(1);
}
console.log(`\n✅ 线上 OTA 审计通过 —— 掌机视角下这条更新链路是通的（⚠️ 只作提醒，不影响结论）。`);
cleanup();
process.exit(0);
