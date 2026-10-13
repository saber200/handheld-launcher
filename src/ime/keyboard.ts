/*
 * 手柄键盘的**输入状态机**：中英文模式、拼音组字、候选选择。
 *
 * ## 为什么单独放一个模块
 *
 * 键盘的状态有三个消费者，放在组件里哪一个都拿不到：
 *   1. `GamepadKeyboard.tsx` —— 渲染候选条与按键高亮
 *   2. `App.tsx` 的 `backOnce` —— 手柄 B 键：**先取消组字**，没有组字才关键盘
 *   3. `App.tsx` 的 LB/RB —— 翻候选
 *
 * 所以沿用本仓库已经用惯的路子：模块级状态 + `useSyncExternalStore`（和
 * `settings/prefs.ts`、`useGamepadNav` 里的数字键盘标志位是同一套写法），
 * 而不是把状态提进 App 再一层层往下传。
 *
 * ## 字段的读写不在这里
 *
 * 「往输入框里写字 / 取光标位置」和焦点系统是同一件事，留在 `useGamepadNav.ts`，
 * 由它通过 `bindKeyboardField` 把两个操作注入进来。这样**只有一处知道光标和值怎么改**。
 */
import { useSyncExternalStore } from "react";
import { candidatesFor, splitSyllables, type Candidate } from "./pinyin";
import { learnedWords, rememberWord, subscribeLearned } from "./learned";
import { buildWordIndex, wordIndex } from "./wordIndex";
import { pinyinTable } from "./pinyinTable";

export type KeyboardMode = "zh" | "en";

type Snapshot = {
  /** 拼音组字串（已敲但还没上屏）。空 = 没在组字。 */
  composing: string;
  candidates: Candidate[];
  /** 当前高亮的候选下标。 */
  selected: number;
  mode: KeyboardMode;
};

/** 组字串上限。超过就当用户误触了，不再往上堆。 */
const MAX_COMPOSING = 32;

let snapshot: Snapshot = { composing: "", candidates: [], selected: 0, mode: "zh" };
const listeners = new Set<() => void>();

/**
 * 往输入框写字 / 从输入框删一个字符。由 `useGamepadNav` 注入 —— 它才知道光标在哪、
 * 怎么触发 React 的受控更新。
 */
type FieldOps = {
  /** 在光标处插入文本。 */
  insert: (text: string) => void;
  /** 退格：删掉光标前的一个字符（或选区）。 */
  backspace: () => void;
};

let ops: FieldOps | null = null;

export function bindKeyboardField(next: FieldOps | null) {
  ops = next;
}

function emit() {
  listeners.forEach((listener) => listener());
}

/**
 * 引擎「认识」的全部词 = 库内词（界面文字里抽的）+ 用户选过的词。
 *
 * 为什么合成一张表：对引擎来说两者含义相同 ——「这是个真的词」。区别只体现在权重上：
 * 库内词是弱证据（出现次数 = 在界面上被看到的次数），用户选过的词是强证据
 * （`candidatesFor` 会把它直接顶到候选条最前面，不参与打分）。
 * 同一个词两边都有时取**相加** —— 用户在界面上见过它、又亲手选过，确实是更强的证据。
 *
 * 缓存起来：这个函数在每次敲键时都会被调用，而两张源表都可能上万条。
 */
let knownCache: { key: string; words: Map<string, number>; overrides: Map<string, string> } | null = null;

/**
 * 把源表合成引擎要的两样东西：
 *
 *   - `words`：引擎「认识」的全部词 → 权重。库内词 + 用户选过的词（同一词次数相加）。
 *   - `overrides`：`"音节|字" → 字`。让词里的字**一定能进切分**。
 *
 * ## `overrides` 为什么必须有（实测踩出来的）
 *
 * 引擎每个音节只取前 `HEAD_LIMIT`（12）个高频字进 DP。但**真实词里的字常常排得很后**：
 * 「键盘」的「键」在 `jian` 桶里排第 **19**，于是 `jian|pan` 这条路**根本生成不出来** ——
 * 词表再准确也救不了，因为候选里压根没有那个字。`shubiao`（鼠标）、`shezhi`（设置）、
 * `mokuai`（模组）都是同一个原因，加了词表也不动。
 *
 * 所以「认识一个词」不只是给它加分，还要**保证它的字在候选里**：把词里每个字的
 * `音节|字` 塞进 `overrides`，引擎组合音节时会把它们插到该音节候选表的最前面。
 * 只对词表里出现过的字这么做，不会把整张表搅乱。
 */
function knownWords(): { words: ReadonlyMap<string, number>; overrides: ReadonlyMap<string, string> } {
  const learned = learnedWords();
  let learnedSize = 0;
  for (const bucket of learned.values()) learnedSize += bucket.size;
  const library = wordIndex()?.words;
  // 用「两张源表的大小」当缓存键：任何一张变了都必然改变这个字符串
  const key = `${library?.size ?? 0}:${learnedSize}`;
  if (knownCache && knownCache.key === key) return knownCache;

  const words = new Map<string, number>(library ?? []);
  for (const bucket of learned.values()) {
    for (const [word, count] of bucket) words.set(word, (words.get(word) ?? 0) + count);
  }

  const overrides = new Map<string, string>();
  const syllablesOf = pinyinTable()?.syllablesOf();
  if (syllablesOf) {
    for (const word of [...words.keys()]) {
      for (const ch of word) {
        // 词里的每个字也单独算「认识」：不然打单字（`xie` → 谢）时，那个字在桶里排第 5、
        // 拿不到任何加成，引擎就会给出桶里第一位的「些」。
        if (!words.has(ch)) words.set(ch, 1);
        for (const syllable of syllablesOf.get(ch) ?? []) overrides.set(`${syllable}|${ch}`, ch);
      }
    }
  }

  knownCache = { key, words, overrides };
  return knownCache;
}

/** 重新算候选与高亮。调用方负责先把 `composing` 写进 snapshot。 */
function recompute(keepSelection: boolean) {
  const { composing } = snapshot;
  if (!composing) {
    snapshot = { ...snapshot, candidates: [], selected: 0 };
    return;
  }
  // 表还没加载上时 `pinyinTable()` 是 null，`candidatesFor` 会返回空 —— 英文照打，
  // 中文等表到位（`pinyinTable` 加载完会 emit，界面重渲染即可）。
  const known = knownWords();
  const candidates = candidatesFor(composing, known.words, {
    pinyinToString: learnedWords().get(composing),
    overrides: known.overrides,
  });
  const selected = keepSelection ? Math.min(snapshot.selected, Math.max(candidates.length - 1, 0)) : 0;
  snapshot = { ...snapshot, candidates, selected };
}

/**
 * 用界面上的文字建一次词索引（`wordIndex.ts` 里有完整理由）。
 *
 * 这里**只做一次、且只在表就绪后做**：`syllablesOf()` 要遍历整份字表，没必要在
 * 每次打开键盘时重算，也没必要在表还没到时就白跑。
 */
export function ensureWordIndex() {
  if (!pinyinTable()) return;
  if (wordIndex()) return;
  const text = typeof document === "undefined" ? "" : document.body.innerText;
  if (!text) return;
  buildWordIndex(text, pinyinTable()!.syllablesOf());
}

/** 学过的词表变了（用户在别处学会 / 清空）→ 候选重排。 */
subscribeLearned(() => {
  if (!snapshot.composing) return;
  recompute(true);
  emit();
});

export function keyboardState(): Snapshot {
  return snapshot;
}

export function subscribeKeyboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useKeyboardState(): Snapshot {
  return useSyncExternalStore(subscribeKeyboard, keyboardState);
}

export function keyboardMode(): KeyboardMode {
  return snapshot.mode;
}

export function setKeyboardMode(mode: KeyboardMode) {
  if (snapshot.mode === mode) return;
  // 换语言时丢掉没上屏的组字：留着「汉语拼音」挂在英文模式上只会让人困惑
  snapshot = { composing: "", candidates: [], selected: 0, mode };
  emit();
}

export function toggleKeyboardMode() {
  setKeyboardMode(snapshot.mode === "zh" ? "en" : "zh");
}

/** 键盘打开 / 关闭时清干净组字（避免下次打开还挂着上次没上屏的拼音）。 */
export function resetKeyboardInput() {
  if (!snapshot.composing && snapshot.selected === 0 && snapshot.candidates.length === 0) return;
  snapshot = { ...snapshot, composing: "", candidates: [], selected: 0 };
  emit();
}

/**
 * 敲一个可见字符。
 *
 * **中文模式下只有字母进组字**，数字和符号直接上屏 —— 这是拼音输入法的通行行为，
 * 用户敲 `-` 是要打连接符，不是要组字。
 */
export function pressKey(char: string) {
  if (!ops) return;
  if (snapshot.mode === "zh" && /^[a-z]$/.test(char)) {
    if (snapshot.composing.length >= MAX_COMPOSING) return;
    snapshot = { ...snapshot, composing: snapshot.composing + char };
    recompute(false);
    emit();
    return;
  }
  ops.insert(char);
}

/**
 * 退格。
 *
 * 有组字时先吃拼音字母，**不动输入框里已有的字** —— 否则用户打错一个字母按删除，
 * 会连输入框里已经上屏的内容一起删掉，那是很恼人的 bug。
 */
export function pressBackspace() {
  if (!ops) return;
  if (snapshot.composing) {
    snapshot = { ...snapshot, composing: snapshot.composing.slice(0, -1) };
    recompute(false);
    emit();
    return;
  }
  ops.backspace();
}

/** 空格：有候选就选第一个上屏，没有就打一个空格。 */
export function pressSpace() {
  if (!ops) return;
  if (snapshot.composing && snapshot.candidates.length) {
    commitCandidate(snapshot.selected);
    return;
  }
  ops.insert(" ");
}

/** 候选上屏：写进输入框、记进自学习、清掉组字。 */
export function commitCandidate(index: number) {
  if (!ops || !snapshot.composing) return;
  const candidate = snapshot.candidates[index];
  if (!candidate) return;
  const pinyin = snapshot.composing;
  ops.insert(candidate.text);
  rememberWord(pinyin, candidate.text);
  snapshot = { ...snapshot, composing: "", candidates: [], selected: 0 };
  emit();
}

/** 光标在候选条上左右移动。返回是否消费了这次按键。 */
export function moveCandidate(delta: number): boolean {
  const total = snapshot.candidates.length;
  if (!snapshot.composing || total === 0) return false;
  const next = (snapshot.selected + delta + total) % total;
  if (next === snapshot.selected) return false;
  snapshot = { ...snapshot, selected: next };
  emit();
  return true;
}

/**
 * 取消组字（手柄 B 键）。返回 true = 这次按键被吃掉了，调用方不要再关键盘。
 * 没在组字时返回 false，交给「关键盘」那条路。
 */
export function cancelComposition(): boolean {
  if (!snapshot.composing) return false;
  snapshot = { ...snapshot, composing: "", candidates: [], selected: 0 };
  emit();
  return true;
}

/** 界面上把 `nihao` 显示成 `ni'hao`（切不出来就不加分隔符）。 */
export function displayComposing(composing: string): string {
  const parts = splitSyllables(composing);
  return parts && parts.length > 1 ? parts.join("'") : composing;
}
