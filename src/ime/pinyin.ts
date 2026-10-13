/*
 * 拼音输入引擎：把用户敲的字母串（`nihao`）变成可选的中文候选（`你好` / `你` / `好` …）。
 *
 * ## 为什么自己写，而不是挂 librime
 *
 * 本仓库的输入需求很窄：**只在自己这几个输入框里打字**，不要系统输入法、不要云候选、
 * 不要自造词。挂 librime 要打包动态库 + 词库（体积与许可都要处理），而后端换来的能力
 * 这里一样都用不上。引擎本身是「音节切分 + 按常用度排序」，几百行就够。
 *
 * ## 算法：对整串拼音做动态规划，直接给出「整词候选」
 *
 * 这是本引擎和「一个字一个字选」的输入法最大的区别，也是手柄上最要紧的一点：
 *
 *   - 朴素做法：敲 `nihao` → 先让你选 `ni` 的字，再选 `hao` 的字（两次选择）
 *   - 本做法：敲 `nihao` → 直接给出 `你好`（**一次确认就上屏**）
 *
 * 做法是把输入切成音节的所有合法方案都枚举出来（`nihao` 可以是 `ni|hao`，也可以是
 * `ni|ha|o`），每种方案用「词频 × 字数」打分，取分高的当候选。于是 `你好` 会排在
 * `你哈哦` 前面 —— 不需要任何词库，只靠字表里的**单字频率**就能推出来。
 *
 * 数据只有单字频率（来自 Unihan 的 `kHanyuPinlu`），所以：
 *   - 常见词排得对（`你好`、`中国`、`什么` 都是高频字组合）
 *   - 生僻组合可能排得怪 —— 这是**已知的取舍**，靠 `learned.ts` 的自学习来补：
 *     用户真选过的词会记住，下次直接排第一。
 */
import { pinyinTable } from "./pinyinTable";

/**
 * 一次最多枚举多少种切分组合（DP 里每拼一条部分解算一次）。
 *
 * **这个数不能小。** 曾经写 4000：加上 `overrides`（认识词里的字会额外进候选）之后每个
 * 音节的候选变多，组合数是乘法增长的，预算在 DP 跑到最前面之前就耗光了 —— 结果是位置 0
 * 的桶为空、**所有长词候选全部消失**（实测 `zhongguo` 返回 0 个候选）。
 * 现在给到 20 万：仍然是一道防爆闸，但正常输入根本碰不到。
 */
const MAX_SEGMENTATIONS = 200_000;

/**
 * 尾部最多允许丢掉几个字母去找候选。
 *
 * 用户打字时尾部总有一个「还没打完的音节」（`zhongg` 的 `g`），DP 要求整串可切分，
 * 于是那一刻候选条会是空的。丢掉尾巴能立刻给出 `zhong` 的候选 —— 正是用户想要的。
 * 但只丢**一个**：丢多了会让乱输入也去枚举无意义的切分。
 */
const MAX_DROPPED_TAIL = 1;
/** 候选条上限。第一屏只显示前几个，翻页也翻不了这么多，纯粹防止极端输入把内存撑爆。 */
const MAX_CANDIDATES = 60;

/**
 * 单字的「常用度当量」：直接取表里的实测频率数值，取对数。
 *
 * 为什么是实测数值而不是「在桶里排第几」：位置是个**很噪的代理**。实测踩过：
 * `shijie` 拼成「是阶」而不是「世界」（「阶」在 `jie` 里排第 1，「界」排第 4，
 * 但真实频率是 19 对 1312 —— 差 70 倍），`shenme` 拼成「社嗯么」而不是「什么」。
 * 有了数值，「世」(1114) + 「界」(1312) 自然赢过「是」(27098) + 「阶」(19)。
 *
 * 为什么取**对数**：频率是长尾分布（「的」27098，「阶」19）。线性相加会让单个高频字
 * 压过整个词；取 log 之后「常用字」之间变成量级比较，这正是切分要的判断。
 *
 * 没有实测数据的字给 1 —— 比实测最低频还低，但不至于让含生僻字的词直接出局
 * （用户可能就是要把那个字打出来）。
 */
function frequencyScore(frequency: number): number {
  return Math.log10(Math.max(frequency, 1));
}

/**
 * 每个音节取前多少个候选字进 DP。
 *
 * 12 是调出来的：`shi` 桶里「世」排第 7（用在「世界」），取 8 是够的；但 `jie` 桶里
 * 「界」排第 4、`shen` 桶里「什」排第 1 —— 而**真正的词往往不是全由第一候选组成**。
 * 取太小会让长词直接拼不出来（实测 `nihao` 没问题但 `shijie` 全错）。
 */
const HEAD_LIMIT = 12;

/**
 * DP 每个位置保留多少条部分解。
 *
 * **这个数比 HEAD_LIMIT 大得多是有原因的**：DP 从后往前推，越靠前的位置会累积大量
 * 分数相近的碎片解（`是给饿`、`是己饿`、`是机饿`…），如果只留十几条，正经的词
 * （`世界`）会被这些碎片挤出去 —— 实测就是这个问题，`shijie` 拼成「是给饿」。
 * 32 条留出了足够的宽度，代价是多算一些组合（仍在 `MAX_SEGMENTATIONS` 之内）。
 */

/**
 * 音节长度的惩罚。**这一项不能省**。
 *
 * 光看「平均常用度」会让拆得越碎分越高：`nihao` 拆成 `ni|ha|o` 时每个字都取到高频字
 * （你 / 哈 / 哦），平均分反而可能高过 `ni|hao`（你 / 好）。而 `zhongguo` 会被切成
 * `zh|o|ng|g|uo` 这种五段碎片 —— `zh` `ng` `g` 根本不是音节，只是正好撞上了
 * `zhi`（之）`ng`（嗯）`ge`（个）这些桶。
 *
 * 所以每个音节按长度打折：完整音节（3 字母以上）不罚，双字母轻罚，单字母重罚。
 * 于是「少而完整的音节」赢过「多而碎的拼凑」。
 */
/**
 * 音节完整度：完整音节（3 字母以上，`zhong` `guo`）算满分，双字母扣一点，
 * 单字母（只有 `a` `o` `e` 三个是合法的）扣得多。
 *
 * 这是**加法项**而不是乘法项 —— 见 `scoreOf` 里的解释。
 */
function syllableQuality(length: number): number {
  if (length >= 3) return 1;
  if (length === 2) return 0.55;
  return 0.05;
}

/** 单字候选：一个字 + 它的频率分。 */
type Piece = { text: string; score: number };

/**
 * DP 里的部分解：除了逐字累加的 `score`，还要记住**已经用掉几个音节**（`length`）与
 * **音节完整度的累计值**（`quality`）—— 排序时要按音节数归一，这两项缺一不可。
 */
type Partial = Piece & {
  quality: number;
  length: number;
  /** 这条解用到的音节（顺序）。界面上的分隔符与它一致，见 `splitSyllables`。 */
  parts: string[];
};

/**
 * 取某个音节的候选字，带上各自的频率分（长度惩罚在组合时才算，见 `segmentations`）。
 * 表里的字符串本身就是按常用度排好序的，取前 `limit` 个即可。
 */
function piecesFor(syllable: string, limit: number, overrides: ReadonlyMap<string, string>): Piece[] {
  const bucket = pinyinTable()?.syllables.get(syllable);
  if (!bucket) return [];
  const out: Piece[] = [];
  const seen = new Set<string>();

  // 认识词里的字**必须**在候选里，哪怕它在桶里排得很后（「键」排第 19，只取前 12 就会漏掉，
  // 于是「键盘」这条路根本生成不出来）。做法是从桶里把它捞出来放到最前面。
  for (const [key, ch] of overrides) {
    if (!key.startsWith(`${syllable}|`)) continue;
    const entry = bucket.find((item) => item.ch === ch);
    if (!entry || seen.has(ch)) continue;
    seen.add(ch);
    // 分数用它的**真实频率**，不是位置 —— 加成由 `wordBonus` 给，不在这里重复计
    out.push({ text: ch, score: frequencyScore(entry.frequency) });
  }

  for (const entry of bucket) {
    if (out.length >= limit + overrides.size) break;
    if (seen.has(entry.ch)) continue;
    seen.add(entry.ch);
    out.push({ text: entry.ch, score: frequencyScore(entry.frequency) });
  }
  return out;
}

/**
 * 给一条切分打分。**这个公式是整个引擎的核心，改之前先读完这段。**
 *
 * ## 要解决的问题
 *
 * 同一个拼音串能切成很多种音节组合，而且**字数还不一样**：
 *
 *     wenjian → wen|jian  = 文件      （2 音节 / 2 字）
 *             → wen|ji|an = 问己安     （3 音节 / 3 字）
 *             → we|n|ji|an = …         （4 音节 / 4 字）
 *
 * 比的是「哪一种切分更像人话」。三个必须同时成立的要求：
 *
 *   1. **常用字优先**：每个字按 log 频率计分（见 `frequencyScore`）。
 *   2. **完整音节优先**：碎片音节必须被显著惩罚，否则「问给啊嗯」会赢过「文件」——
 *      `啊` `嗯` 都是超高频字，光看字频它们很占便宜。
 *   3. **认识词优先**：`words` 里的词（库里的词 + 用户选过的词）大幅加成。这一条
 *      不能省 —— 单字频率**在原理上**就判断不出词边界，见 `wordIndex.ts` 的说明。
 *
 * ## 为什么是「乘平均、加完整度」而不是「乘惩罚因子」
 *
 * 一开始写的是「每个音节乘一个惩罚因子、连乘」。那**让两个字合成的词吃亏**：
 * 碎片切分音节多、每个音节都参加连乘，惩罚被摊薄，结果 `问给啊嗯`（4 音节）反而
 * 压过 `文件`（2 音节）。实测就是这么错的。
 *
 * 改成现在这个式子：
 *
 *     score = (log 频率之和 / 音节数) × (音节完整度的平均) × 认识词加成
 *
 *   - 除以**音节数**（不是字数）：「每个音节平均有多常用」。
 *   - 乘**完整度的平均**：完整音节 1.0 / 双字母 0.55 / 单字母 0.05。
 *   - 乘**认识词加成**：见 `wordBonus`。
 *
 * ## 还有一条踩过的坑：剪枝必须用同一个公式
 *
 * DP 每层要砍掉大部分部分解。**砍的时候必须用这个公式**（`comparePartial`），
 * 曾经用「原始累加分」砍 —— 而每个音节都会往累加分里加一个 log 频率，于是音节越多
 * 分越高，两音节的正确切分在参与最终排序之前就被裁掉了（实测：`zhongguo` 的候选里
 * 根本没有「中国」）。**剪枝和排序必须是同一把尺子。**
 */
function scoreOf(score: number, syllables: number, quality: number, words: ReadonlyMap<string, number>, text: string): number {
  if (syllables <= 0) return 0;
  return (score / syllables) * (quality / syllables) * wordBonus(words, text);
}

/**
 * 「这个词我认识」的加成。
 *
 * 为什么给这么大的权重（最多 8 倍）：**单字频率在原理上判断不出词边界**。`shijie`
 * 用单字频率算出来「是阶」赢「世界」（是 27098 vs 世 1114），因为模型没有「世界是个词」
 * 这条信息。词表就是补这条信息的，所以它必须能压过字频的差距。
 *
 * 权重是**调出来的**：先用 `1 + log10(次数+1)`（1 次只有 1.3 倍），55 个日常词只对 27 个；
 * 给到 6 倍以上才对 54 个。所以这一项必须能压过字频差距，否则词表等于没加。
 *
 * 用**平方**而不是直接乘常数：`(1 + log10(次数))²` 让「见过很多次的词」比「只见过一次
 * 的词」强得多（10 次 4 倍 / 100 次 9 倍），不需要维护任何阈值。封顶 30 倍防极端值。
 */
function wordBonus(words: ReadonlyMap<string, number>, text: string): number {
  if (words.size === 0) return 1;
  const count = words.get(text);
  if (!count) return 1;
  // `(1 + log10(次数))²`：见过 1 次 → 1 倍，10 次 → 4 倍，100 次 → 9 倍，封顶 30 倍。
  const weight = 1 + Math.log10(count + 1);
  return Math.min(weight * weight, 30);
}

/**
 * 把 `pinyin` 切成音节的所有方案，每种方案组合成一个候选词。
 *
 * 动态规划从后往前推：`best[i]` = 从第 i 个字母到末尾能拼出的若干条组合。
 * 转移就是「在 i 处切一个音节 s（长度 1..longest），再接上 best[i + s.length]」。
 *
 * 只保留「最优」而不是保留全部：输入 20 个字母时全枚举会爆炸。
 * 但为了候选条能有多个选择，这里对每个位置保留**一批**方案（`MAX_CANDIDATES` 条）。
 *
 * 分数沿路**累加**（每个字贡献 log 频率、每个音节贡献长度惩罚），排序时再按字数与
 * 惩罚归一 —— 归一不能放在 DP 里面做，因为部分解的「最终字数和音节数」还没定，
 * 提前归一会让 DP 拿错的标准做剪枝（实测过：那样长词会被剪掉）。
 */
function segmentations(
  pinyin: string,
  words: ReadonlyMap<string, number>,
  overrides: ReadonlyMap<string, string>,
  /** true = 只要一条最优切分（省掉每个音节的多个候选字）。 */
  bestOnly = false,
): Partial[] {
  const table = pinyinTable();
  if (!table || !pinyin) return [];
  const n = pinyin.length;
  /** best[i] = 从 i 到末尾的若干条候选（已按分数降序） */
  const best: Partial[][] = Array.from({ length: n + 1 }, () => []);
  best[n] = [{ text: "", score: 0, quality: 0, length: 0, parts: [] }];
  let explored = 0;

  for (let i = n - 1; i >= 0; i -= 1) {
    const bucket: Partial[] = [];
    for (let len = Math.min(table.longest, n - i); len >= 1; len -= 1) {
      const syllable = pinyin.slice(i, i + len);
      const heads = piecesFor(syllable, bestOnly ? 1 : HEAD_LIMIT, overrides);
      if (!heads.length) continue;
      const quality = syllableQuality(len);
      const tails = best[i + len];
      if (!tails.length) continue;
      for (const head of heads) {
        for (const tail of tails) {
          if (explored >= MAX_SEGMENTATIONS) break;
          explored += 1;
          bucket.push({
            text: head.text + tail.text,
            score: head.score + tail.score,
            quality: quality + tail.quality,
            length: tail.length + 1,
            parts: [syllable, ...tail.parts],
          });
        }
      }
    }
    // 同一个位置上留一批继续往前接（排序尺子和最终一致，见 `comparePartial`）
    bucket.sort((a, b) => comparePartial(a, b, words));
    best[i] = bucket.slice(0, MAX_CANDIDATES);
  }

  if (best[0].length > 0) return best[0];
  // 整串切不动 → 用**最长的可切分前缀**的候选（见 `longestPrefix`）
  return longestPrefix(pinyin, words, overrides);
}

/**
 * 「最长的可切分前缀」的候选 —— 只在那串拼音**整串切不动**时才用得上。
 *
 * ## 为什么需要（用户的真实输入就是这样）
 *
 * 用户是一个字母一个字母敲的。敲到 `zhongg` 时，尾巴上那个 `g` 还是半截音节，而 DP
 * 要求「整串都能切成合法音节」—— 于是最有用的那一刻（刚敲出 `zhong`）候选条反而是空的，
 * 用起来像卡住了。
 *
 * ## 为什么必须用**正向** DP，不能从后向 DP 里捡
 *
 * 后向 DP 的 `best[k]` 是「从第 k 个字母**开始的后缀**」的解。想拿前缀（`zhong`）就得
 * 找「前 5 个字母」的解，而那是 `best[5]` 反过来的东西 —— 在后向表里根本不存在。
 * 一开始我就在这里绕了很久：`best[5]` 看起来正好是「zhong 那条」，其实它是 `"g"` 那条，
 * 于是永远返回空。**换成正向 DP 一眼就对**：`fwd[i]` = 前 i 个字母的解。
 *
 * 只允许丢一个字母：丢多了，乱输入（`zzzz`）也会去枚举一堆无意义的切分。
 */
function longestPrefix(
  pinyin: string,
  words: ReadonlyMap<string, number>,
  overrides: ReadonlyMap<string, string>,
): Partial[] {
  const table = pinyinTable();
  if (!table) return [];
  const n = pinyin.length;
  /** fwd[i] = 前 i 个字母的若干条候选（已按分数降序） */
  const fwd: Partial[][] = Array.from({ length: n + 1 }, () => []);
  fwd[0] = [{ text: "", score: 0, quality: 0, length: 0, parts: [] }];
  let explored = 0;

  for (let i = 1; i <= n; i += 1) {
    const bucket: Partial[] = [];
    for (let len = 1; len <= Math.min(table.longest, i); len += 1) {
      const syllable = pinyin.slice(i - len, i);
      const heads = piecesFor(syllable, HEAD_LIMIT, overrides);
      if (!heads.length) continue;
      const prev = fwd[i - len];
      if (!prev.length) continue;
      const quality = syllableQuality(len);
      for (const head of heads) {
        for (const tail of prev) {
          if (explored >= MAX_SEGMENTATIONS) break;
          explored += 1;
          bucket.push({
            text: tail.text + head.text,
            score: head.score + tail.score,
            quality: quality + tail.quality,
            length: tail.length + 1,
            parts: [...tail.parts, syllable],
          });
        }
      }
    }
    bucket.sort((a, b) => comparePartial(a, b, words));
    fwd[i] = bucket.slice(0, MAX_CANDIDATES);
  }

  // 从最长的前缀往回找第一个切得动的
  for (let i = n - 1; i >= Math.max(n - MAX_DROPPED_TAIL, 1); i -= 1) {
    if (fwd[i].length > 0) return fwd[i];
  }
  return [];
}

/**
 * DP 剪枝时的排序。
 *
 * **这里曾经按「原始累加分」排，那是个 bug**：每个音节都会往累加分里加一个 log 频率，
 * 所以**音节越多总分越高**。于是位置 0 的桶里全是三、四音节的碎片
 * （`中古喔` 8.34），两音节的正确切分（`中国` 7.50）被挤出保留名额 —— 实测就是这个
 * 现象：`zhongguo` 的候选里根本没有「中国」，而最终排序公式算出来它本该是第一。
 *
 * 教训：**剪枝用的尺子必须和最终排序用的是同一把**，否则好解在还没参与排序时就被裁掉。
 * 所以这里直接调用最终打分函数 `scoreOf`。
 */
function comparePartial(a: Partial, b: Partial, words: ReadonlyMap<string, number>): number {
  const sa = scoreOf(a.score, a.length, a.quality, words, a.text);
  const sb = scoreOf(b.score, b.length, b.quality, words, b.text);
  return sa !== sb ? sb - sa : (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
}
/**
 * 最优切分的音节列表（`zhonghuarenmingongheguo` → zhong/hua/ren/min/gong/he/guo）。
 *
 * 走的是**和候选生成同一条 DP**，所以界面上的分隔符和引擎的判断永远一致。
 * 早先这里用的是「贪心最长匹配」，两者会打架：贪心把 `mingong` 切成 `ming|ong`，
 * 而 DP 认为正解是 `min|gong` —— 于是 `overrides` 里的 `min|民` 根本没机会生效，
 * 长词永远拼不出来（实测「中华人民共和国」被切成「中話人民工和国」）。
 */
export function bestSyllables(pinyin: string, words: ReadonlyMap<string, number> = new Map()): string[] {
  const parts = segmentations(pinyin, words, new Map(), true);
  return parts.length > 0 ? parts[0].parts : [];
}

/** 上屏用的候选。`learned` = 用户亲手选过这个词（界面给个记号）。 */
export type Candidate = {
  text: string;
  learned: boolean;
};

/** 内部排序用的中间形态（比对完就丢掉分数）。 */
type Scored = Candidate & { score: number };

/**
 * 输入串 → 候选表。
 *
 * @param pinyin  已经清过非字母字符的输入（调用方保证是 `[a-z]*`）
 * @param known   引擎「认识」的词：`词 → 出现次数`。来源有两处，合成一张表传进来：
 *                  - `wordIndex.ts` 从启动器界面里抽的库内词（游戏名 / 文件名…）
 *                  - `learned.ts` 记住的用户选过的词（权重更高，见 `options.learned`）
 * @param options `pinyinToString` 是当前输入串下**用户亲手选过**的词，会直接顶到候选条最前面。
 */
export function candidatesFor(
  pinyin: string,
  known: ReadonlyMap<string, number> = new Map(),
  options: {
    pinyinToString?: ReadonlyMap<string, number>;
    /** `"音节|字" → 字`：保证认识词里的字能进切分，见 `keyboard.ts` 的 `knownWords`。 */
    overrides?: ReadonlyMap<string, string>;
  } = {},
): Candidate[] {
  if (!pinyin) return [];

  // 同一个词可能由不同切分得到（`你好` 只有一种，但长串会有多种），取最高分那份
  const ranked = new Map<string, number>();
  for (const piece of segmentations(pinyin, known, options.overrides ?? new Map())) {
    if (!piece.text) continue;
    const score = scoreOf(piece.score, piece.length, piece.quality, known, piece.text);
    const prev = ranked.get(piece.text);
    if (prev === undefined || score > prev) ranked.set(piece.text, score);
  }

  let scored: Scored[] = [];
  for (const [text, score] of ranked) scored.push({ text, score, learned: false });
  scored.sort((a, b) => b.score - a.score || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  // 用户亲手选过的词顶到最前面：那比任何统计都准，也不再参与打分比较
  const mine = options.pinyinToString;
  if (mine && mine.size > 0) {
    const boosted: Scored[] = [];
    const rest: Scored[] = [];
    for (const candidate of scored) {
      if (mine.has(candidate.text)) boosted.push({ text: candidate.text, score: 0, learned: true });
      else rest.push(candidate);
    }
    // 学过的按「选过几次」排，选得多的更靠前
    boosted.sort((a, b) => (mine.get(b.text) ?? 0) - (mine.get(a.text) ?? 0));
    // 学过但这次没被切出来的词也补上（比如刚学完就改了输入）
    for (const text of mine.keys()) {
      if (!boosted.some((c) => c.text === text)) boosted.push({ text, score: 0, learned: true });
    }
    scored = [...boosted, ...rest];
  }

  return scored.slice(0, MAX_CANDIDATES).map(({ text, learned: was }) => ({ text, learned: was }));
}

/**
 * 把输入串切成音节（界面上的 `ni'hao` 分隔符用它）。
 *
 * 复用 `bestSyllables`（同一条 DP），**不再自己贪心匹配** —— 两套切法会得出不同结果，
 * 那样界面显示的分隔符会和引擎实际选的字对不上，用户看着就是「明明显示 ni'hao，
 * 出来的却是别的东西」。
 *
 * 切不出来（尾字母还没输完）时返回 null，界面就不显示分隔符。
 */
export function splitSyllables(pinyin: string): string[] | null {
  if (!pinyin) return null;
  const parts = bestSyllables(pinyin);
  // 拼回去必须和原串完全一致，否则说明有字符没被覆盖（半截拼音），不标分隔
  return parts.length > 0 && parts.join("") === pinyin ? parts : null;
}
