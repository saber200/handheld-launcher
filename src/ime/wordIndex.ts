/*
 * 从**启动器自己的界面文字**里学词：把库里已有的中文词建成词表，喂给拼音引擎。
 *
 * ## 为什么需要它（这是本键盘能不能用的关键）
 *
 * 字表只有**单字频率**，而中文的词边界**靠单字频率根本判断不出来**。实测过：
 * 55 个日常词里只有 13 个首位命中，`youxi` 给出「有西」而不是「游戏」、
 * `wenjian` 给出「问见」而不是「文件」。原因是「是」的字频(27098)远高于「世」(1114)，
 * 模型没有别的依据，只能把票投给「是」。
 *
 * 通用词表能解决，但**许可都不干净**（雾凇拼音/rime-ice 是 GPL-3.0；网上那些 HSK /
 * 词频表多半派生自 CC-CEDICT 的 BY-SA，又没有 LICENSE 文件）。见
 * `scripts/gen-pinyin-data.mjs` 里那段说明。
 *
 * ## 所以改用启动器里已有的文字
 *
 * **用户要打的词，本来就在他自己的库里**：游戏名、软件名、文件夹名、文件名。
 * 在搜索框里打「游戏」、在重命名里打「存档」「备份」「截图」—— 这些词全都已经
 * 显示在这个界面上。直接读屏幕上的文字建索引：
 *
 *   - **零许可问题**：不打包任何第三方词表，读的是用户自己机器上的界面内容。
 *   - **比通用词表更对症**：索引里就是他库里的词，不是通用语料里的词。
 *   - **零维护**：库变了（装了新游戏）索引跟着变，不需要谁去更新一份词表。
 *
 * ## 它是怎么被用的
 *
 * 只做一件事：告诉引擎「这个词是个真的词」。引擎在给整个拼音串切分时，命中词表的
 * 切分拿一份加成（见 `pinyin.ts` 的 `scoreOf`）。选过的词另外走 `learned.ts`，
 * 按用户实际选择次数加成 —— 那份权重更高。
 *
 * 索引在**第一次打开键盘**时建一次（`document.body.innerText`），之后不再重建：
 * 建一次几毫秒，而键盘打开是用户按一下的事，不值得每次重扫。
 */

/**
 * 一个词最多几个字。
 *
 * 给到 8 而不是 4：长词恰恰是最值得认的 ——「中华人民共和国」7 个字，如果只认到 4 个字，
 * 引擎就永远拿不到这条信息，长词会被拆成「中話人民工和国」这种字频最高的拼凑（实测）。
 */
const MAX_WORD_LENGTH = 8;
/** 词条上限。超了就按出现次数砍尾 —— 索引只是加成，不必求全。 */
const MAX_WORDS = 20000;
/** 只索引 CJK 汉字。标点、拉丁字母、数字都不算词的一部分。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

export type WordIndex = {
  /** 词 → 出现次数。 */
  words: Map<string, number>;
  /** 建索引时扫了多少字符（日志用）。 */
  scanned: number;
};

let index: WordIndex | null = null;

/**
 * 从一段文字里抽词。
 *
 * 做法是**用字表当验证器**，不是硬切 n-gram：先按汉字切段，再对每段枚举 2..4 字的
 * 连续子串，逐个去字表里查「这个子串的拼音能不能切成合法音节」。查得通才算词 ——
 * 于是「是阶」这种虽然常见、但不是词的字对混不进来（它的拼音 `shijie` 当然合法…
 * 所以这一步只挡掉真正的垃圾，比如跨标点、含数字的组合）。
 *
 * 剩下的判断交给引擎自己的打分：索引只是「这个词出现过」的弱证据，不是硬规则。
 */
export function extractWords(text: string, syllableOf: Map<string, string[]>): Map<string, number> {
  const words = new Map<string, number>();
  // 按非汉字切开，段内才是可能成词的地方
  let run = "";
  const flush = () => {
    if (run.length >= 2) {
      for (let i = 0; i < run.length; i += 1) {
        for (let len = 2; len <= MAX_WORD_LENGTH && i + len <= run.length; len += 1) {
          const candidate = run.slice(i, i + len);
          // 每个字都要有读音，否则这个词打不出来，索引它没意义
          if (![...candidate].every((ch) => syllableOf.has(ch))) continue;
          words.set(candidate, (words.get(candidate) ?? 0) + 1);
        }
      }
    }
    run = "";
  };
  for (const ch of text) {
    if (CJK.test(ch)) run += ch;
    else flush();
  }
  flush();
  return words;
}

/**
 * 建一次索引（重复调用直接返回缓存）。
 *
 * @param syllableOf 字 → 该字的音节列表（由调用方从拼音字表反查出来的）
 */
export function buildWordIndex(text: string, syllableOf: Map<string, string[]>): WordIndex {
  if (index) return index;
  const words = extractWords(text, syllableOf);
  let entries = [...words.entries()];
  if (entries.length > MAX_WORDS) {
    // 出现次数多的优先；同次数时长的优先（长词信息量大）
    entries.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    entries = entries.slice(0, MAX_WORDS);
  }
  index = { words: new Map(entries), scanned: text.length };
  return index;
}

export function wordIndex(): WordIndex | null {
  return index;
}

/** 测试用：清掉缓存。 */
export function resetWordIndex() {
  index = null;
}
