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
  /**
   * 修饰键状态（对标 OneXPlayer 那把键盘的手柄映射）：
   *   - `shift`：**按住** LT 期间为真（松开即失效）
   *   - `shiftLock`：L2 一按锁上、再按一下松开（「相当于长按 Shift」）
   *   - `caps`：L3 切换的大写锁定
   * 界面上要**看得见**这三个状态，否则用户不知道自己是「按住」还是「锁上了」。
   */
  shift: boolean;
  shiftLock: boolean;
  caps: boolean;
};

/** 组字串上限。超过就当用户误触了，不再往上堆。 */
const MAX_COMPOSING = 32;

let snapshot: Snapshot = {
  composing: "",
  candidates: [],
  selected: 0,
  mode: "zh",
  shift: false,
  shiftLock: false,
  caps: false,
};
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
  /** 当前输入框能不能接受换行（`textarea` 能，`input` 不能）。 */
  multiline: () => boolean;
};

/**
 * 「请求关掉键盘」的钩子。由 `GamepadKeyboard` 注册 —— 不在这里直接 import
 * `useGamepadNav` 的 `closeGamepadKeyboard`，因为本模块已经被它反过来依赖（字段读写），
 * 两边互相 import 会绕成环（同 `bindKeyboardClosedHook` 那处的处理）。
 */
let closeRequest: (() => void) | null = null;

export function bindKeyboardCloseRequest(hook: (() => void) | null) {
  closeRequest = hook;
}

function requestClose() {
  closeRequest?.();
}

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
  // 换语言时丢掉没上屏的组字：留着「汉语拼音」挂在英文模式上只会让人困惑。
  // 修饰键**保留** —— 用户按着 Shift 切中英，不该把 Shift 弄丢。
  snapshot = { ...snapshot, composing: "", candidates: [], selected: 0, mode };
  emit();
}

export function toggleKeyboardMode() {
  setKeyboardMode(snapshot.mode === "zh" ? "en" : "zh");
}

/** 键盘打开 / 关闭时清干净组字（避免下次打开还挂着上次没上屏的拼音）。 */
export function resetKeyboardInput() {
  // 修饰键也要复位：`shift` 是「按住 LT」的镜像，键盘都关了还留着「按着 Shift」，
  // 下次打开打出来的就是大写，而用户什么都没按。
  if (
    !snapshot.composing &&
    snapshot.selected === 0 &&
    snapshot.candidates.length === 0 &&
    !snapshot.shift &&
    !snapshot.shiftLock &&
    !snapshot.caps
  ) {
    return;
  }
  snapshot = { ...snapshot, composing: "", candidates: [], selected: 0, shift: false, shiftLock: false, caps: false };
  emit();
}

/**
 * 符号键按住 Shift 时打出来的东西（美式键盘布局）。
 *
 * 只列**和键面不同**的那些；不在表里的符号（如 `-` `_` 之外的）Shift 后仍是自身。
 * 键面本身在 `keyLayout.ts`，这张表是「同一个键的另一个形态」。
 */
const SHIFTED: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%",
  "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|",
  ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?", "`": "~",
};

/**
 * 按当前修饰键状态把键面字符变换成实际要打出的字符。
 *
 * 三种情况分开处理，因为它们的语义不同：
 *
 *   1. **中文组字**：字母必须以**小写**进缓冲区（拼音就是小写），Shift / Caps 不许干扰 ——
 *      否则 `nihao` 变成 `NIHAO`，引擎一个音节都切不出来。
 *      大写需求在中文模式下没有意义（上屏的是汉字）。
 *   2. **Caps 或 Shift-Lock**（锁定态）：字母变大写；符号也按 Shift 形态（真键盘的 Caps
 *      其实不影响符号，但这里锁定的语义是「当 Shift 一直按着」，所以一起变）。
 *   3. **按住 Shift**：只影响**这一个字符**，打完就没了（`shift` 由 LT 的松开事件清掉，
 *      不需要这里消费）。
 */
export function transformKey(char: string): string {
  // 中文组字要小写字母，修饰键不参与
  if (snapshot.mode === "zh" && /^[a-z]$/.test(char)) return char;
  const upper = snapshot.caps || snapshot.shiftLock || snapshot.shift;
  if (!upper) return char;
  if (/^[a-z]$/.test(char)) return char.toUpperCase();
  if (snapshot.caps || snapshot.shiftLock || snapshot.shift) return SHIFTED[char] ?? char;
  return char;
}

/**
 * 敲一个可见字符。
 *
 * **中文模式下只有字母进组字**，数字和符号直接上屏 —— 这是拼音输入法的通行行为，
 * 用户敲 `-` 是要打连接符，不是要组字。
 */
export function pressKey(char: string) {
  if (!ops) return;
  const out = transformKey(char);
  if (snapshot.mode === "zh" && /^[a-z]$/.test(out)) {
    if (snapshot.composing.length >= MAX_COMPOSING) return;
    snapshot = { ...snapshot, composing: snapshot.composing + out };
    recompute(false);
    emit();
    return;
  }
  ops.insert(out);
}

/** 按住 LT 期间为真；松开即失效（`shiftLock` 不受影响）。 */
export function setShift(down: boolean) {
  if (snapshot.shift === down) return;
  snapshot = { ...snapshot, shift: down };
  emit();
}

/** L2：一按锁上 Shift、再按一下松开（用户要的「相当于长按 Shift」）。 */
export function toggleShiftLock() {
  snapshot = { ...snapshot, shiftLock: !snapshot.shiftLock };
  emit();
}

/** L3：大写锁定。 */
export function toggleCaps() {
  snapshot = { ...snapshot, caps: !snapshot.caps };
  emit();
}

/**
 * RT = Enter。行为分两种情况，因为**单行输入框塞不进换行**：
 *
 *   1. **多行（textarea）**：先确认没上屏的拼音，再真的换行。
 *   2. **单行（input）**：确认拼音之后**关掉键盘**（等于「完成」）。
 *
 * 第 2 条是踩出来的：一开始无条件 `insert("\n")`，而 `<input>` 会把换行吃掉 ——
 * 用户敲完 `nihao` 按 RT，结果是「候选上屏了但什么都没发生」，看着像卡住。
 * 启动器里的输入框**绝大多数是单行的**（搜索框、重命名、新建文件名），所以这条必须分。
 *
 * 无论哪种情况，**先把没上屏的拼音确认掉**：用户敲完 `nihao` 直接按回车，意图显然是
 * 「把你好打出来」，不是「放弃」。真键盘上的中文输入法也是这个行为。
 */
export function pressEnter() {
  if (!ops) return;
  if (snapshot.composing) {
    if (snapshot.candidates.length) {
      // 有候选：上屏第一个（用户的意图就是「把你好打出来」）
      commitCandidate(snapshot.selected);
    } else {
      /*
       * 有组字但**一个候选都没有** → 把拼音原文当文本上屏。
       *
       * 什么时候会没有候选：字表还没加载上、或者用户根本不是在打拼音 ——
       * 中文模式下敲 `apex`（想搜游戏）就是一个候选都切不出来。
       * 这时候按回车如果只是把字母丢掉，用户会看到「敲的字凭空消失」。
       * 上屏原文才是预期行为。
       */
      const raw = snapshot.composing;
      snapshot = { ...snapshot, composing: "", candidates: [], selected: 0 };
      emit();
      ops.insert(raw);
    }
  }
  if (ops.multiline()) ops.insert("\n");
  else requestClose();
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

/**
 * 手柄按键 → 键盘动作。**对标 OneXPlayer 那把键盘的映射**：
 *
 *   | 手柄 | 动作 |
 *   | --- | --- |
 *   | `Y`（△） | 空格（有候选时=确认第一个候选） |
 *   | `X`（□） | 退格 |
 *   | `RT` | 回车（先确认没上屏的拼音，再回车） |
 *   | `LT` | Shift：**按住**生效，松开失效 |
 *   | `L2` | Shift 锁定：一按锁上、再按一下松开 |
 *   | `L3` | 大写锁定（Caps） |
 *
 * 集中在这里而不是散在 `App.tsx` 里，是因为这些动作**只对键盘有意义**，
 * 而且「按下 / 松开」成对（`setShift(true)` / `setShift(false)`）—— 放一起不容易漏掉松开的那个。
 */
export const gamepadKeyActions = {
  space: pressSpace,
  backspace: pressBackspace,
  enter: pressEnter,
  shiftDown: () => setShift(true),
  shiftUp: () => setShift(false),
  toggleShiftLock,
  toggleCaps,
} as const;

/** 光标在候选条上左右移动（物理键盘的左右方向键）。返回是否消费了这次按键。 */
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
 * 候选条一页最多几颗（用户 2026-10-16：「联想词每次最多显示9个 然后通过lb和rb键进行翻页显示」）。
 *
 * 为什么是 9：候选的序号就是数字键 1–9（按哪颗选哪个），一页超过 9 颗，第 10 颗起
 * 就没有键能选它了 —— 旧版把整条候选从头到尾编成 1、2、3…无限，超出 9 的序号是死的。
 */
export const CANDIDATES_PER_PAGE = 9;

/**
 * LB/RB：候选条**整页**翻。返回是否消费了这次按键（没在组字时是 false）。
 *
 * 页没有自己的状态，从 `selected` 推出来（`Math.floor(selected / 9)`）——「翻页」就是
 * 把高亮挪到目标页**同一个位置**。这样做的好处：空格 / RT 确认的永远是眼前这一页里
 * 高亮的那颗，显示与确认永远不会错位；而物理左右方向键（`moveCandidate`）逐颗挪动
 * 跨过页边界时，页也会自然跟着走，两条路共用一个真相。
 */
export function pageCandidate(delta: number): boolean {
  const total = snapshot.candidates.length;
  if (!snapshot.composing || total === 0) return false;
  const pages = Math.ceil(total / CANDIDATES_PER_PAGE);
  const page = Math.floor(snapshot.selected / CANDIDATES_PER_PAGE);
  // 首尾环绕：第一页按 LB 直达最后一页（和 moveCandidate 的循环手感一致）
  const target = (page + delta + pages) % pages;
  const offset = snapshot.selected - page * CANDIDATES_PER_PAGE;
  // 最后一页往往不满 9 颗：落点取「原来的位置」与「目标页实际颗数」的小者
  const targetSize = Math.min(CANDIDATES_PER_PAGE, total - target * CANDIDATES_PER_PAGE);
  snapshot = { ...snapshot, selected: target * CANDIDATES_PER_PAGE + Math.min(offset, targetSize - 1) };
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
