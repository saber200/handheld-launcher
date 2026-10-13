/*
 * 手柄键盘的「自学习词库」：记住用户真正选过的词。
 *
 * 为什么需要它：字表里**只有单字频率，没有词频**（原因见 `gen-pinyin-data.mjs` 顶部：
 * 带词频的词库几乎都是 GPL，不能随包）。于是 `nihao` 的正确排序只能靠「高频字组合」
 * 推出来 —— 常见词没问题，用户自己的习惯用词（人名、游戏名、缩写）就不行了。
 *
 * 这份记忆正好补上这个洞，而且**它记的就是这台机器上这个人真正打的词**，比任何
 * 通用词库都准。用户选过一次 `wode` → `我的`，下次 `wode` 的第一个候选就是「我的」。
 *
 * 存在 localStorage（和 `settings/prefs.ts` 同一个路子：只影响这台机器，后端一个字都不必知道）。
 * 读不出来 / 存不下都**不当错误处理**：这是一层优化，坏了最多是回到「按单字频率排」。
 */

const KEY = "handheld-launcher.ime.learned.v1";

/** 总词条上限。学满之后只保留选得最多的那些，防止无限增长。 */
const MAX_WORDS = 500;
/** 单个拼音串下最多记几个词。 */
const MAX_PER_PINYIN = 8;

/** 拼音串 → （词 → 被选次数）。 */
export type LearnedMap = Map<string, Map<string, number>>;

let current: LearnedMap = read();
let snapshot: ReadonlyMap<string, ReadonlyMap<string, number>> = current;
const listeners = new Set<() => void>();

function read(): LearnedMap {
  const out: LearnedMap = new Map();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return out;
    for (const [pinyin, words] of Object.entries(parsed as Record<string, unknown>)) {
      // 只收形状对的条目：手改过 localStorage 的内容不值得信任
      if (!/^[a-z]{1,32}$/.test(pinyin) || !words || typeof words !== "object") continue;
      const bucket = new Map<string, number>();
      for (const [word, count] of Object.entries(words as Record<string, unknown>)) {
        if (typeof word !== "string" || !word || typeof count !== "number" || count <= 0) continue;
        bucket.set(word, Math.min(count, 9999));
      }
      if (bucket.size) out.set(pinyin, bucket);
    }
  } catch {
    return new Map();
  }
  return out;
}

function persist() {
  try {
    const plain: Record<string, Record<string, number>> = {};
    for (const [pinyin, words] of current) plain[pinyin] = Object.fromEntries(words);
    localStorage.setItem(KEY, JSON.stringify(plain));
  } catch {
    // 存不下（隐私模式 / 配额满）：这一次仍然生效，只是下次启动忘掉。
  }
}

/** 超出上限时砍掉「选得最少」的条目。 */
function trim() {
  let total = 0;
  for (const words of current.values()) total += words.size;
  if (total <= MAX_WORDS) return;

  const flat: { pinyin: string; word: string; count: number }[] = [];
  for (const [pinyin, words] of current) {
    for (const [word, count] of words) flat.push({ pinyin, word, count });
  }
  flat.sort((a, b) => b.count - a.count);
  const keep = new Set(flat.slice(0, MAX_WORDS).map((row) => `${row.pinyin}\u0000${row.word}`));
  for (const [pinyin, words] of current) {
    for (const word of [...words.keys()]) {
      if (!keep.has(`${pinyin}\u0000${word}`)) words.delete(word);
    }
    if (!words.size) current.delete(pinyin);
  }
}

/**
 * 记一次「用户选了这个词上屏」。
 *
 * @param pinyin 上屏时输入框里的拼音串
 * @param word   用户选中的词（一个字也记 —— 下次它就会排在这个音节的第一位）
 */
export function rememberWord(pinyin: string, word: string) {
  if (!/^[a-z]{1,32}$/.test(pinyin) || !word || word.length > 16) return;
  const words = current.get(pinyin) ?? new Map<string, number>();
  words.set(word, (words.get(word) ?? 0) + 1);
  // 同一个拼音下只留选得最多的几个
  if (words.size > MAX_PER_PINYIN) {
    const kept = [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PER_PINYIN);
    current.set(pinyin, new Map(kept));
  } else {
    current.set(pinyin, words);
  }
  trim();
  snapshot = current;
  persist();
  listeners.forEach((listener) => listener());
}

/** 给引擎用的只读视图。引用稳定，可以直接喂给 `useSyncExternalStore` 的选择器。 */
export function learnedWords(): ReadonlyMap<string, ReadonlyMap<string, number>> {
  return snapshot;
}

export function forgetLearnedWords() {
  current = new Map();
  snapshot = current;
  persist();
  listeners.forEach((listener) => listener());
}

export function subscribeLearned(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
