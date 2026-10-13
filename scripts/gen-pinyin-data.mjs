#!/usr/bin/env node
/*
 * 生成手柄键盘用的中文拼音字表：`public/pinyin-syllables.txt`
 *
 * ## 数据从哪来、为什么不拿现成的输入法词库
 *
 * 中文输入法词库（雾凇拼音 / 小狼毫那一套）几乎都是 **GPL-3.0**，随安装包分发会传染本仓库
 * （见 `THIRD-PARTY-NOTICES.md` 的规矩）。所以这里只用 **Unicode 官方数据**：
 *
 *   - `Unihan_Readings.txt` 的 `kMandarin`    —— 汉字 → 普通话读音（44k 字）
 *   - `Unihan_Readings.txt` 的 `kHanyuPinlu`  —— 汉字 → 读音 + **实测频率数值**
 *   - `Unihan_Variants.txt` 的 `kTraditionalVariant` —— 判断一个候选字是不是繁体
 *
 * Unihan 由 Unicode 联盟发布（Unicode License，MIT 类，可随包）。
 *
 * ## 那个频率数值是这张表的关键
 *
 * 一开始走的是 `mozillazg/pinyin-data`（MIT），但那份数据**把 `kHanyuPinlu` 的频率数字丢了**
 * （只留 `U+597D: hǎo`），于是「哪些字算常用」只剩一个集合、集合内部排不出顺序：
 * 实测出现 `hao` 的第一个候选是**号**而不是**好**。回到 Unihan 原始数据，数字是在的 ——
 * **好 6060 / 号 462**、**你 10944 / 吻 10**、**是 27098**。所以官方数据是唯一来源。
 *
 * ## 排序规则（依次比较）
 *
 *   1. `kHanyuPinlu` 里**有频率数字**的排前面（0 频/无数据的字垫底）
 *   2. 同样有频率时，**非繁体**的排前面（`kTraditionalVariant` 指向别的字 = 它是繁体）
 *   3. 频率数值大的排前面
 *   4. 最后按码位 —— 纯粹为了让每次生成的字节完全相同
 *
 * 繁体**只降级不删除**：用户真要打繁体字也不该打不出来，只是不该抢在简体前面。
 *
 * ## 产物格式（一行一个音节，尽量紧凑）
 *
 *     a 啊:0,阿:0,呵:0
 *     hao 好:6060,号:462,毫:225
 *
 * 每个候选字后面跟着它的 **kHanyuPinlu 频率数值**（没有数据的写 0）。
 *
 * 为什么非要把数字带上、而不是只排好序就完事：切分算法要在**相邻音节之间**比较
 * 「哪个字更常用」（`shijie` 该切成 `shi|jie` 还是别的、其中该取「世」还是「是」）。
 * 只给顺序的话引擎只能拿「在桶里排第几」当频率用，而这个代理很噪 —— 实测
 * `shijie` 会被拼成「是阶」而不是「世界」，`shenme` 拼成「社嗯么」而不是「什么」。
 * 带上真实数值，引擎就能算「世」(1114) + 「界」(547) 远胜「是」(27098) + 「阶」(19)。
 *
 * 体积代价：150 KB → 约 380 KB（一次性静态资源，不占运行时内存）。值。
 *
 * 用法：`node scripts/gen-pinyin-data.mjs`
 * 只有需要更新字表时才跑（要联网）；产物已提交进仓库，**构建不依赖网络**。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "pinyin-syllables.txt");

/** 官方数据源（单一 zip，含本次要用的两个 txt）。 */
const UNIHAN_ZIP = "https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip";
const READINGS = "Unihan_Readings.txt";
const VARIANTS = "Unihan_Variants.txt";

/**
 * 把带声调的拼音压成纯字母音节：`nǐ` → `ni`、`lǜ` → `lv`。
 *
 * 用 Unicode 分解把声调符号剥掉（声调是组合字符）。`ü` 一律写成 `v`，因为手柄键盘上
 * 没有 `ü` 这个键 —— 用户按 v 是拼音输入法的通行约定。
 */
function baseSyllable(raw) {
  const decomposed = raw.normalize("NFD");
  let out = "";
  for (const ch of decomposed) {
    const code = ch.codePointAt(0);
    // 组合附加符号（声调）直接丢掉
    if (code >= 0x0300 && code <= 0x036f) continue;
    out += ch;
  }
  return out.replace(/[üǖǘǚǜ]/g, "v").replace(/u:/g, "v").toLowerCase();
}

/** `U+4E00` → `一`。 */
function codePointToChar(token) {
  const hex = token.trim().replace(/^U\+/i, "");
  const code = Number.parseInt(hex, 16);
  return Number.isFinite(code) ? String.fromCodePoint(code) : null;
}

/** 按 `字段名` 把 `Unihan_*.txt` 切成「码位 → 该字段原文」。 */
function readFields(text, field) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [code, key, ...rest] = line.split("\t");
    if (key !== field || rest.length === 0) continue;
    const ch = codePointToChar(code);
    if (ch) rows.push([ch, rest.join("\t")]);
  }
  return rows;
}

/**
 * `kHanyuPinlu` 的值形如 `hǎo(6060) hāo(142) hào(115)`；取该字的最大频率作为它的常用度。
 * 这个数字来自《现代汉语频率词典》的统计，是「哪个字更常用」唯一可靠的依据。
 */
function parsePinlu(value) {
  const readings = [];
  let best = 0;
  for (const token of value.trim().split(/\s+/)) {
    if (!token) continue;
    const match = /^(.*?)(?:\((\d+)\))?$/.exec(token);
    if (!match || !match[1]) continue;
    const count = match[2] ? Number.parseInt(match[2], 10) : 0;
    readings.push(baseSyllable(match[1]));
    if (count > best) best = count;
  }
  return { readings, frequency: best };
}

function downloadUnihan() {
  const tmp = mkdtempSync(join(tmpdir(), "unihan-"));
  const zip = join(tmp, "Unihan.zip");
  process.stdout.write(`下载 Unihan（Unicode 官方）：${UNIHAN_ZIP}\n`);
  execFileSync("curl", ["-sL", "--fail", "--max-time", "180", UNIHAN_ZIP, "-o", zip], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  execFileSync("unzip", ["-o", "-q", zip, READINGS, VARIANTS, "-d", tmp], {
    stdio: ["ignore", "ignore", "inherit"],
  });

  const read = (name) => {
    const path = join(tmp, name);
    if (!existsSync(path)) throw new Error(`解压后找不到 ${name}`);
    return readFileSync(path, "utf8");
  };
  const result = { readings: read(READINGS), variants: read(VARIANTS) };
  rmSync(tmp, { recursive: true, force: true });
  return result;
}

function build() {
  const { readings, variants } = downloadUnihan();

  /**
   * 一个候选字是不是「繁体写法」。
   *
   * **必须用 `kSimplifiedVariant` 判，不能用 `kTraditionalVariant`。** 两个字段看着对称，
   * 实际口径完全不同（实测）：
   *
   *   - `号` 的 `kTraditionalVariant` 是 `号 號`（**包含它自己**）→ 用它会得出「号是繁体」
   *   - `號` 的 `kSimplifiedVariant` 是 `号`（**另一个字**）→ 这才是「它有个简体写法」
   *
   * 所以判据是：`kSimplifiedVariant` 指向了**别的**字，这个字才是繁体。
   */
  const traditional = new Set();
  for (const [ch, value] of readFields(variants, "kSimplifiedVariant")) {
    const targets = value
      .trim()
      .split(/\s+/)
      .map(codePointToChar)
      .filter((t) => t !== null);
    if (targets.some((t) => t !== ch)) traditional.add(ch);
  }

  /** 码位 → { 频率, 读音音节[] }。先铺 `kMandarin`（面最广），再用 `kHanyuPinlu` 补频率与读音。 */
  const info = new Map();
  for (const [ch, value] of readFields(readings, "kMandarin")) {
    // kMandarin 只给「最常用的那一个读音」，可能是 `nǐ` 也可能是 `nǐ,nì`
    const syllables = value
      .split(/[,\s]+/)
      .map(baseSyllable)
      .filter((s) => /^[a-z]{1,6}$/.test(s));
    if (syllables.length) info.set(ch, { frequency: 0, syllables });
  }
  for (const [ch, value] of readFields(readings, "kHanyuPinlu")) {
    const { readings: syllables, frequency } = parsePinlu(value);
    const usable = syllables.filter((s) => /^[a-z]{1,6}$/.test(s));
    if (!usable.length) continue;
    // kHanyuPinlu 的读音比 kMandarin 全（多音字都能拿到），有它就整条覆盖
    info.set(ch, { frequency, syllables: usable });
  }

  /** @type {Map<string, {ch:string, frequency:number, traditional:boolean}>} */
  const bySyllable = new Map();
  for (const [ch, { frequency, syllables }] of info) {
    // 同一个字可能在这个音节里出现多次：`好` 的 kHanyuPinlu 是 `hǎo(6060) hāo(142) hào(115)`，
    // 三个读音剥掉声调后**都是 `hao`**。按音节去重，否则候选条里会连着出现三个「好」。
    for (const syllable of new Set(syllables)) {
      const entry = { ch, frequency, traditional: traditional.has(ch) };
      const bucket = bySyllable.get(syllable);
      if (bucket) bucket.push(entry);
      else bySyllable.set(syllable, [entry]);
    }
  }

  const byRank = (a, b) =>
    // 1. 有实测频率的排前面
    (a.frequency > 0 ? 0 : 1) - (b.frequency > 0 ? 0 : 1) ||
    // 2. 简体优先
    Number(a.traditional) - Number(b.traditional) ||
    // 3. 频率高的优先
    b.frequency - a.frequency ||
    // 4. 码位，保证生成结果稳定可复现
    a.ch.codePointAt(0) - b.ch.codePointAt(0);
  for (const bucket of bySyllable.values()) bucket.sort(byRank);

  const lines = [...bySyllable.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    // `好:6060`。频率 0 的字（大概是生僻字）也要写出来，否则解析时对不上号。
    .map(([syllable, bucket]) => `${syllable} ${bucket.map((e) => `${e.ch}:${e.frequency}`).join(",")}`);

  const total = bySyllable.values().reduce((n, bucket) => n + bucket.length, 0);
  const withFrequency = [...info.values()].filter((v) => v.frequency > 0).length;
  const header = [
    "# 手柄键盘的拼音字表。由 `node scripts/gen-pinyin-data.mjs` 生成，请勿手改。",
    "# 数据源：Unicode 官方 Unihan 数据库（Unicode License，MIT 类）——",
    "#   kMandarin（读音）、kHanyuPinlu（读音 + 实测频率）、kTraditionalVariant（识别繁体）。",
    "# 格式：<音节> <候选字:频率,…>（频率来自 kHanyuPinlu，0 = 没有实测数据）",
    `# 统计：${lines.length} 个音节 / ${total} 个字条目 / 其中 ${withFrequency} 个字带实测频率`,
    "",
  ].join("\n");

  writeFileSync(OUT, `${header}${lines.join("\n")}\n`, "utf8");
  const bytes = readFileSync(OUT).byteLength;
  process.stdout.write(
    `已写入 ${OUT}：${lines.length} 个音节，${total} 个字条目，${(bytes / 1024).toFixed(1)} KB\n`,
  );
}

build();
