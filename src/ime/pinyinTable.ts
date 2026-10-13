/*
 * 拼音字表的加载与解析（手柄键盘的中文输入用）。
 *
 * 表在 `public/pinyin-syllables.txt`，随包分发、**构建时不依赖网络**；内容由
 * `node scripts/gen-pinyin-data.mjs` 从 Unicode 官方 Unihan 数据生成（MIT 类许可，见
 * `THIRD-PARTY-NOTICES.md`）。格式是一行一个音节，每个候选字带实测频率：
 *
 *     hao 好:6060,号:462,毫:225,耗:86,…
 *
 * 为什么是文本而不是 JSON：同样体积下这个格式**一次 split 就能建表**，不用整份
 * `JSON.parse`；而且可以直接用 grep 查（调排序规则时这点很方便）。
 *
 * 缺表不是错误：英文、数字、文件名照样能打，只是没有中文候选，所以要**如实降级**
 * 而不是抛出去把键盘整个打不开。
 */
import { useSyncExternalStore } from "react";

/**
 * 表所在位置。开发时 Vite 从站点根提供 `public/`，Tauri 里是打包进 dist 的静态资源。
 * 桌面壳用的是自定义协议（`tauri://` / `http://tauri.localhost`），**根相对路径在两种
 * 情况下都成立**，所以不写死任何一种。
 */
const TABLE_URL = "pinyin-syllables.txt";

/** 上限只是防御性的：真表是 417 个音节，正常永远碰不到。 */
const MAX_SYLLABLES = 2000;

/** 一个候选字和它的实测频率（0 = Unihan 里没有这个字的频率数据）。 */
export type PinyinEntry = {
  ch: string;
  frequency: number;
};

export type PinyinTable = {
  /** 音节 → 候选字（按常用度排）。 */
  syllables: Map<string, PinyinEntry[]>;
  /** 最长音节的字母数，用来给切分算法封顶。 */
  longest: number;
  /** 一个音节最多有多少候选字（界面用它决定要不要翻页）。 */
  maxCharacters: number;
  /** 字 → 该字的所有音节。**懒建**：只有 `wordIndex` 要用，别拖慢键盘打开。 */
  syllablesOf: () => Map<string, string[]>;
};

type State =
  | { status: "loading"; table: null }
  | { status: "ready"; table: PinyinTable }
  | { status: "missing"; table: null };

let state: State = { status: "loading", table: null };
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

/**
 * 解析表正文。**格式不对的行直接跳过、不抛异常** —— 一份坏掉的字表不该让键盘变成砖头，
 * 最差情况是「中文没候选、英文照打」。
 */
export function parseTable(text: string): PinyinTable {
  const syllables = new Map<string, PinyinEntry[]>();
  let longest = 0;
  let maxCharacters = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const gap = line.indexOf(" ");
    if (gap <= 0) continue;
    const syllable = line.slice(0, gap);
    if (!/^[a-z]{1,6}$/.test(syllable)) continue;
    if (syllables.size >= MAX_SYLLABLES && !syllables.has(syllable)) continue;

    const entries: PinyinEntry[] = [];
    for (const token of line.slice(gap + 1).split(",")) {
      const item = token.trim();
      if (!item) continue;
      // `好:6060`。**缺了 `:频率` 也收**（频率记 0）：这样手写一份精简表也能用，
      // 不至于因为格式少了一半就整份作废。
      const colon = item.indexOf(":");
      const ch = (colon < 0 ? item : item.slice(0, colon)).trim();
      // 一个候选只该是一个字。用码点长度判断，别用 `.length` —— emoji 会占两个单元。
      if (Array.from(ch).length !== 1) continue;
      const frequency = colon < 0 ? 0 : Number.parseInt(item.slice(colon + 1), 10);
      entries.push({ ch, frequency: Number.isFinite(frequency) && frequency > 0 ? frequency : 0 });
    }
    if (!entries.length) continue;
    syllables.set(syllable, entries);
    if (syllable.length > longest) longest = syllable.length;
    if (entries.length > maxCharacters) maxCharacters = entries.length;
  }

  let reverse: Map<string, string[]> | null = null;
  return {
    syllables,
    longest: Math.max(longest, 1),
    maxCharacters,
    syllablesOf() {
      if (reverse) return reverse;
      const built = new Map<string, string[]>();
      for (const [syllable, entries] of syllables) {
        for (const entry of entries) {
          const list = built.get(entry.ch);
          // 同一个字在不同音节里出现多次（多音字），去重
          if (list) {
            if (!list.includes(syllable)) list.push(syllable);
          } else {
            built.set(entry.ch, [syllable]);
          }
        }
      }
      reverse = built;
      return built;
    },
  };
}

/** 开始（或复用）加载。重复调用只会真正跑一次。 */
export function loadPinyinTable(): Promise<void> {
  if (pending) return pending;
  // 浏览器预览（macOS 上 `npm run dev`）也要能用中文键盘 —— 静态资源同样由 Vite 提供，
  // 所以这里**不需要**为预览造假数据，真表就是可用的。`inTauri()` 只用于日志措辞。
  pending = (async () => {
    try {
      const response = await fetch(TABLE_URL, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const table = parseTable(await response.text());
      if (table.syllables.size === 0) throw new Error("表里一个音节都没有");
      state = { status: "ready", table };
    } catch (error) {
      // 如实降级：键盘仍可用（英文 / 数字 / 符号），只是中文没有候选。
      state = { status: "missing", table: null };
      console.warn("拼音字表没加载上：", error instanceof Error ? error.message : error);
    }
    emit();
  })();
  return pending;
}

export function pinyinTableState(): State {
  return state;
}

export function pinyinTable(): PinyinTable | null {
  return state.table;
}

export function subscribePinyinTable(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 给组件用：表就绪后自动重渲染（加载失败也会收到通知，好去画「中文不可用」）。 */
export function usePinyinTable(): State {
  return useSyncExternalStore(subscribePinyinTable, pinyinTableState);
}
