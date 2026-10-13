/*
 * 拼音引擎的测试：`node --test src/ime/pinyin.test.ts`
 *
 * 为什么值得有：这张表的**排序质量就是键盘的手感**，而「`nihao` 第一个候选是不是你好」
 * 这种事靠肉眼在浏览器里点是看不全的 —— 417 个音节、44k 个字条目，只能靠测试钉住。
 *
 * 测试跑的是**真实链路**：拦截 `fetch` 读仓库里那份 `public/pinyin-syllables.txt`，
 * 走 `loadPinyinTable()` 的解析与降级逻辑，再问 `candidatesFor()` 要候选。
 * 所以数据文件被改坏（比如生成脚本改错排序）这里会红。
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadPinyinTable, parseTable, pinyinTable } from "./pinyinTable.ts";
import { candidatesFor, splitSyllables } from "./pinyin.ts";

/*
 * 表的位置按**工作目录**算，不按 `import.meta.url`。
 *
 * 因为测试是被 `scripts/test-web.mjs` 用 esbuild 打包到临时目录再跑的，
 * `import.meta.url` 指向的是临时目录里的那个副本，相对它找 `public/` 必然找不到。
 * 那个脚本固定以仓库根为工作目录起进程，所以这里从 cwd 走是可靠的。
 */
const TABLE_PATH = join(process.cwd(), "public", "pinyin-syllables.txt");

/** 让 `loadPinyinTable()` 从仓库里读文件，而不是真的发 HTTP。 */
async function withTable<T>(run: () => T): Promise<T> {
  const body = readFileSync(TABLE_PATH, "utf8");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, text: async () => body }) as unknown as Response) as typeof fetch;
  try {
    await loadPinyinTable();
    return run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** 候选表头几个词。 */
function top(pinyin: string, count = 5): string[] {
  return candidatesFor(pinyin)
    .slice(0, count)
    .map((c) => c.text);
}

test("字表能解析，音节数与最长音节符合预期", () => {
  const table = parseTable(readFileSync(TABLE_PATH, "utf8"));
  assert.equal(table.syllables.size, 417, "音节数变了：生成脚本或数据源动过");
  assert.equal(table.longest, 6, "最长音节变了（chuang / zhuang 那类）");
  assert.ok(table.syllables.get("hao")!.some((e) => e.frequency > 0), "候选字没带上频率");
  // 排序的第一条断言：这些字必须是各自音节的头号候选
  for (const [syllable, expected] of [
    ["ni", "你"],
    ["hao", "好"],
    ["shi", "是"],
    ["zhong", "中"],
    ["wen", "问"],
  ] as const) {
    assert.equal(table.syllables.get(syllable)?.[0]?.ch, expected, `${syllable} 的首选不对`);
  }
});

test("坏行被跳过、缺频率也收（一份坏表不该让键盘变成砖头）", () => {
  const table = parseTable(
    [
      "# 注释",
      "",
      "hao 好:6060,号:462",     // 正常行
      "ni 你",                  // **缺频率也收**：手写精简表仍然可用
      "ah 啊:12,阿:",            // 频率写成空的，按 0 收
      "这不是一行",              // 没有音节
      "9 数字",                 // 音节不合法
      "ni",                     // 没有候选
      "shuang 双:5,双:9",       // 同一个字重复出现，两次都收（由调用方决定怎么用）
    ].join("\n"),
  );
  assert.deepEqual([...table.syllables.keys()].sort(), ["ah", "hao", "ni", "shuang"]);
  assert.deepEqual(table.syllables.get("ni"), [{ ch: "你", frequency: 0 }]);
  assert.equal(table.syllables.get("hao")![0].frequency, 6060);
  assert.equal(table.syllables.get("ah")![1].frequency, 0);
});

test("没有词表时的底线：常用二字词命中一部分，长词仍能切出来", async () => {
  await withTable(() => {
    // 没有词表 / overrides 时，只有「高频字恰好组成词」的才排得对：
    //   你好（你排第 1、好排第 1）、中国（中 1、国 1）、什么（什 1、么 1）都行
    //   谢谢（谢在 xie 桶里排第 5）不行 —— 这正是词表存在的理由
    assert.equal(top("nihao", 1)[0], "你好");
    assert.equal(top("zhongguo", 1)[0], "中国");
    assert.equal(top("shenme", 1)[0], "什么");
    // 长词：没有词表时**排不出**「华」（它在 hua 桶里排第 13，引擎只取前 12），
    // 所以这里只钉「切成了 7 个字、且都是合法读音」，不钉具体字面。
    // 「排对」由下面那条带词表的测试负责。
    const long = top("zhonghuarenmingongheguo", 1)[0];
    assert.equal(long.length, 7, `长词该切 7 个字，实际「${long}」`);
    assert.deepEqual(splitSyllables("zhonghuarenmingongheguo"), [
      "zhong", "hua", "ren", "min", "gong", "he", "guo",
    ]);
  });
});

test("词表里的字排在候选表之外时，也必须能拼出那个词", async () => {
  await withTable(() => {
    // 「键」在 jian 桶里排第 19，引擎每个音节只取前 12 个 —— 不给 overrides 就永远
    // 拼不出「键盘」。这条测试盯着那个机制：没有它，词表再准也没用。
    const bare = candidatesFor("jianpan", new Map([["键盘", 3]]));
    assert.ok(!bare.slice(0, 5).some((c) => c.text === "键盘"), "前提变了：不加 overrides 居然也能拼出键盘");

    const overrides = new Map([["jian|键", "键"], ["pan|盘", "盘"]]);
    const withOverride = candidatesFor("jianpan", new Map([["键盘", 3]]), { overrides });
    assert.equal(withOverride[0].text, "键盘");
  });
});

test("单音节给单字，且是高频字", async () => {
  await withTable(() => {
    assert.equal(top("ni", 1)[0], "你");
    assert.equal(top("wo", 1)[0], "我");
    assert.equal(top("de", 1)[0], "的");
    // 候选必须够多，否则用户连选字都没得选
    assert.ok(candidatesFor("shi").length >= 10, "shi 的候选太少");
  });
});

/*
 * 这一条钉的是本引擎**已知的界限**，不是「功能没做完」。
 *
 * 单字频率判断不出**词内部**该用哪个字：「华」在 Unihan 里的频率只有 29（它基本只作为
 * 构词成分出现，不作单字用），而「話/话」是 2332 —— 差 80 倍。就算把整个
 * 「中华人民共和国」放进词表并给加成，也算不回来，因为加成只能给**整词**，
 * 而 DP 在半路上必须先用单字频率选出「华」还是「话」。
 *
 * 所以这里**如实断言边界**：整词进不了候选（说明引擎没有偷偷靠不可靠的启发式作弊），
 * 而**用户选过一次之后就一定能出来** —— 那条路由 `learned` 保证，见下一条测试。
 * 什么时候这个测试红了（整词进了候选），说明打分配方有了实质变化，该回来重新评估。
 */
test("多字长词：整词排不出来（单字频率的已知界限），但选过一次就能", async () => {
  await withTable(() => {
    const word = "中华人民共和国";
    const pinyin = "zhonghuarenmingongheguo";
    const so = pinyinTable()!.syllablesOf();
    const overrides = new Map<string, string>();
    for (const ch of word) for (const syllable of so.get(ch) ?? []) overrides.set(`${syllable}|${ch}`, ch);

    const first = candidatesFor(pinyin, new Map([[word, 2]]), { overrides });
    assert.ok(
      !first.some((c) => c.text === word),
      "整词居然排进候选了 —— 打分配方变了，回来重新评估这条边界",
    );

    // 用户从候选里选过一次（`learned` 记的格式是「拼音 → 词」），下次必须在第一位
    const learned = new Map([[pinyin, new Map([[word, 1]])]]);
    const second = candidatesFor(pinyin, new Map(), { pinyinToString: learned.get(pinyin) });
    assert.equal(second[0].text, word, "选过一次的词没有顶到第一位");
    assert.ok(second[0].learned, "没带「学过」标记");
  });
});

test("打了一半的拼音也给候选，不会空手", async () => {
  await withTable(() => {
    // `zhongg` 的尾巴 `g` 不合法，但前面能切出来的部分仍应给候选
    assert.ok(candidatesFor("zhongg").length > 0, "半截拼音不该没有候选");
    // 完全不合法的输入返回空，而不是抛异常
    assert.deepEqual(candidatesFor("zzz"), []);
    assert.deepEqual(candidatesFor(""), []);
  });
});

test("自学习词表能把用户选过的词提到最前", async () => {
  await withTable(() => {
    const mine = new Map([["你好", 3]]);
    const list = candidatesFor("nihao", new Map(), { pinyinToString: mine });
    assert.equal(list[0].text, "你好", "学过的词没有排到第一");
    assert.ok(list[0].learned, "学过的词没带标记");
  });
});

/*
 * 这一段是本键盘能不能用的分水岭。
 *
 * 单字频率**在原理上**判断不出中文的词边界，所以只靠字表时日常词的首位命中率只有
 * 13/55（实测）。`wordIndex.ts` 从启动器界面文字里抽词来补这条信息，下面这份词表就是
 * 模拟「界面上出现过这些词」（真实运行时是游戏名 / 文件名 / 设置项）。
 *
 * 如果哪天有人调打分公式把命中率调低了，这里会红。
 */
test("有词表时，日常词的首位命中率必须够高", async () => {
  await withTable(() => {
    const cases: [string, string][] = [
      ["nihao", "你好"], ["zhongguo", "中国"], ["shenme", "什么"], ["xiexie", "谢谢"],
      ["youxi", "游戏"], ["wenjian", "文件"], ["mingzi", "名字"], ["shijie", "世界"],
      ["shihou", "时候"], ["xianzai", "现在"], ["jintian", "今天"], ["keyi", "可以"],
      ["women", "我们"], ["nimen", "你们"], ["tamen", "他们"], ["zhege", "这个"],
      ["nage", "那个"], ["zenme", "怎么"], ["yinwei", "因为"], ["suoyi", "所以"],
      ["danshi", "但是"], ["ruguo", "如果"], ["diannao", "电脑"], ["shouji", "手机"],
      ["ruanjian", "软件"], ["chengxu", "程序"], ["shezhi", "设置"], ["kaishi", "开始"],
      ["tuichu", "退出"], ["baocun", "保存"], ["shanchu", "删除"], ["sousuo", "搜索"],
      ["tianjia", "添加"], ["xiazai", "下载"], ["wenjianjia", "文件夹"], ["zhuomian", "桌面"],
      ["wendang", "文档"], ["tupian", "图片"], ["yinyue", "音乐"], ["shipin", "视频"],
      ["saomiao", "扫描"], ["anzhuang", "安装"], ["gengxin", "更新"], ["banben", "版本"],
      ["xitong", "系统"], ["wangluo", "网络"], ["dianyuan", "电源"], ["dianchi", "电池"],
      ["liangdu", "亮度"], ["shengyin", "声音"], ["jianpan", "键盘"], ["shubiao", "鼠标"],
      ["shoubing", "手柄"], ["mokuai", "模组"],
    ];
    // 「界面上出现过这些词」——次数给 3（真实界面里一个词往往出现好几次）
    const known = new Map(cases.map(([, word]) => [word, 3]));
    // 词里的字必须能进切分（「键」在 jian 桶里排第 19，不给 overrides 就永远拼不出「键盘」）
    const overrides = new Map<string, string>();
    for (const word of known.keys()) {
      for (const ch of word) {
        for (const syllable of pinyinTable()!.syllablesOf().get(ch) ?? []) {
          overrides.set(`${syllable}|${ch}`, ch);
        }
      }
    }

    const missed: string[] = [];
    let first = 0;
    for (const [pinyin, want] of cases) {
      const got = candidatesFor(pinyin, known, { overrides }).map((c) => c.text);
      if (got[0] === want) first += 1;
      else missed.push(`${pinyin}→${want}（实际 ${got.slice(0, 2).join("/")}）`);
    }
    const rate = first / cases.length;
    assert.ok(rate >= 0.9, `首位命中率只有 ${(rate * 100).toFixed(0)}%（要求 ≥90%）。没命中：\n  ${missed.join("\n  ")}`);
  });
});

test("没有词表时也不会崩，只是排得差（如实降级）", async () => {
  await withTable(() => {
    // 库是空的、什么都没学过 —— 引擎仍要给出候选，用户能一个字一个字选
    assert.ok(candidatesFor("youxi", new Map()).length > 0);
    assert.ok(candidatesFor("nihao", new Map()).length > 0);
  });
});

test("音节切分：能切出来才标分隔符", async () => {
  await withTable(() => {
    assert.deepEqual(splitSyllables("nihao"), ["ni", "hao"]);
    assert.deepEqual(splitSyllables("zhongguo"), ["zhong", "guo"]);
    // 尾巴没打完 → 返回 null，界面上就不显示分隔符
    assert.equal(splitSyllables("zhongg"), null);
  });
});

test("离谱长的输入不会卡死", async () => {
  await withTable(() => {
    const started = Date.now();
    const list = candidatesFor("nihaozhongguoshijieyouxiwenjian".repeat(3));
    const elapsed = Date.now() - started;
    assert.ok(Array.isArray(list));
    assert.ok(elapsed < 2000, `太慢了：${elapsed}ms`);
  });
});
