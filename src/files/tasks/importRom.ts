/*
 * ① 导入 ROM（改造包 §2.4）。
 *
 * 用户想的是「我把 ROM 丢进下载夹了，帮我装进模拟器」，不是「我要把文件从 A 移到 B」。
 * 所以这里只问一件事：从哪个文件夹开始找？剩下的分类、目标、模拟器都由表决定。
 *
 * 光碟镜像（`.iso` / `.bin` / `.img`）不看扩展名看**文件头**（0.1.61，功能 15 第 4 条）：
 * 一个 `.iso` 底下可能是 PS2、PSP、PS1 甚至 Wii 的盘，按扩展名一律塞进 ps2/ 是把用户
 * 的游戏送错地方。读不出魔数的落到「没认出来」那一组，由用户自己指定目标 ——
 * 不瞎猜（判据见 Rust 侧 `winfs.rs::probe_disc`）。
 */
import { invoke } from "@tauri-apps/api/core";
import { text } from "../../i18n";
import type { FileEntry } from "../useFileBrowser";
import { ROM_PLATFORMS, extensionOf } from "../taskMeta";
import { formatBytes, joinPath } from "./env";
import { commonSources } from "./sources";
import { rollbackTransfer, runTransfer } from "./transfer";
import type {
  TaskBucket,
  TaskDef,
  TaskScan,
  TaskScanItem,
  TaskSummary,
} from "./types";

/** 判定表在 `taskMeta.ts`（预览面板也要用它，两处共用一份，免得自相矛盾）。 */
const PLATFORMS = ROM_PLATFORMS;

/** 一次最多搬多少个文件：掌机的 ROM 一般几十个，上千个说明用户选错了文件夹。 */
const MAX_ITEMS = 500;

const UNKNOWN = "unknown";
/** 光碟镜像里「魔法数认不出来 / 只是通用 ISO9660」的那一组的键。 */
const DISC = "disc";

/** 需要读文件头才能定平台的后缀。 */
const DISC_EXTS = [".iso", ".bin", ".img"];

/**
 * 探测的封顶：SD 卡上每读一个文件就是一次开门，上千个镜像能把「选完来源」这一步拖成
 * 几十秒。超出上限的那些按扩展名处理（`.iso` → PS2），并在扫描结果里说明 ——
 * 一个能算出来的上限，比进度条一直转强。
 */
const PROBE_MAX_FILES = 120;
const PROBE_BUDGET_MS = 4000;

function collect(rows: FileEntry[]): TaskScanItem[] {
  const items: TaskScanItem[] = [];
  for (const row of rows) {
    if (row.kind !== "file" || row.hidden) continue;
    const ext = extensionOf(row.name);
    const platform = PLATFORMS.find((entry) => entry.exts.includes(ext));
    items.push({
      path: row.path,
      name: row.name,
      size: row.bytes,
      bucket: platform?.key ?? UNKNOWN,
      meta: { ext },
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/**
 * 把光碟镜像按文件头重新归类。返回「有魔数但认不出来 / 只是通用 ISO9660」的条数
 * （0 表示这一趟没有需要用户自己挑目录的）。读不出来就保持按扩展名的那一组 ——
 * 一次读失败不该让整次扫描白做。
 */
async function probeDiscs(items: TaskScanItem[]): Promise<{ discs: number; unsure: number }> {
  const candidates = items.filter((item) => DISC_EXTS.includes(String(item.meta?.ext ?? "")));
  const started = Date.now();
  let probed = 0;
  let unsure = 0;
  for (const item of candidates) {
    if (probed >= PROBE_MAX_FILES || Date.now() - started > PROBE_BUDGET_MS) break;
    probed += 1;
    try {
      const probe = await invoke<{ kind: string; magic: string }>("file_probe_disc", {
        path: item.path,
      });
      item.meta = { ...item.meta, magic: probe.magic };
      if (probe.kind === "ps2") item.bucket = "ps2";
      else if (probe.kind === "psp") item.bucket = "psp";
      else {
        item.bucket = DISC;
        unsure += 1;
      }
    } catch {
      /* 读不到就打不开这块镜像，保持扩展名的判定，等真搬的时候再报原因 */
    }
  }
  return { discs: probed, unsure };
}

export const importRom: TaskDef = {
  id: "importRom",
  accent: "accent",
  usesConflict: true,
  card: () => text().tasks.cards.importRom,

  unavailable() {
    return null;
  },

  async source(ctx) {
    const options = await commonSources(ctx, [
      { value: ctx.dirs.roms, label: text().tasks.srcRoms },
    ]);
    return {
      label: text().tasks.cards.importRom.title,
      value: options[0]?.value ?? "",
      options,
      hint: text().tasks.sourceBody,
    };
  },

  async scan(ctx, source): Promise<TaskScan> {
    const items = collect(await ctx.list(source));
    const probed = await probeDiscs(items);
    const root = ctx.dirs.roms;
    const buckets: TaskBucket[] = PLATFORMS.filter((platform) =>
      items.some((item) => item.bucket === platform.key),
    ).map((platform) => ({
      key: platform.key,
      label: platform.label,
      target: root ? joinPath(root, platform.folder) : "",
      targetLabel: platform.label,
      emulator: platform.emulator,
      color: platform.color,
    }));
    if (items.some((item) => item.bucket === DISC)) {
      buckets.push({
        key: DISC,
        label: text().tasks.discBucket,
        // 和 UNKNOWN 一样：**不给默认目标**。认不出来的盘倒进 ps2/ 就是把 PS1 的盘
        // 放进了 PCSX2 的目录，用户下次在模拟器里只会看到一个「游戏不见了」。
        target: "",
        targetLabel: text().tasks.discBucket,
        color: "violet",
        manual: true,
        hint: text().tasks.discBucketHint,
      });
    }
    if (items.some((item) => item.bucket === UNKNOWN)) {
      buckets.push({
        key: UNKNOWN,
        label: text().tasks.unknownBucket,
        // 认不出来就**不给默认目标**：把杂七杂八的东西一股脑倒进 ROM 目录是最坏的结果。
        target: "",
        targetLabel: text().tasks.unknownBucket,
        color: "warning",
        manual: true,
        hint: text().tasks.unknownHint,
      });
    }
    const total = items.reduce((sum, item) => sum + item.size, 0);
    const parts = [text().tasks.resultMeta(items.length, formatBytes(total))];
    // 把「读了几个文件头」说出来：用户看到 .iso 不再一律进 ps2/ 时，得知道为什么。
    if (probed.unsure > 0) parts.push(text().tasks.discNote(probed.unsure));
    return { items, buckets, note: parts.join(" · ") };
  },

  fields(_ctx, scan) {
    // 每个分组一个目标字段。认不出平台的那一组目标本来就是空的，用户必须自己挑。
    return scan.buckets.map((bucket) => ({
      kind: "target" as const,
      key: `target:${bucket.key}`,
      label: bucket.label,
      value: bucket.target,
      hint: bucket.emulator ? `→ ${bucket.emulator}` : text().tasks.unknownHint,
    }));
  },

  summary(items, plan): TaskSummary {
    const target = (item: TaskScanItem) =>
      plan.targets[item.bucket] ?? plan.buckets.find((row) => row.key === item.bucket)?.target ?? "";
    // 只算「有目标」的分组：没有目标的分组在执行时会被跳过，算进总量就是骗人。
    // 这条规则必须和 `run()` 里那个 filter 一模一样 —— 两处不一致，用户就会在摘要里
    // 看到一个数、实际搬走另一个数。
    const counted = items.filter((item) => target(item) !== "");
    const totalBytes = counted.reduce((sum, item) => sum + item.size, 0);
    const notes = [text().tasks.sumEstimate];
    if (plan.conflict === "replace") {
      // 被覆盖掉的旧文件是**回滚不了**的：先把话说明白，别等用户取消了才发现。
      notes.push(text().tasks.replaceNoRollback);
    }
    if (items.some((item) => item.bucket === UNKNOWN)) notes.push(text().tasks.unknownHint);
    if (items.some((item) => item.bucket === DISC)) notes.push(text().tasks.discBucketHint);
    return {
      count: counted.length,
      totalBytes,
      etaSec: totalBytes / (45 * 1024 * 1024),
      conflictPolicy: plan.conflict,
      notes,
    };
  },

  async run(ctx, plan, onProgress, signal) {
    let done = 0;
    const moved: { from: string; to: string }[] = [];
    const groups = plan.buckets.filter(
      // 只按「有没有目标」决定搬不搬，**不看 `manual`**：manual 的含义是「没有默认目标、
      // 要用户自己挑」（见 types.ts），用户挑完就该搬。以前这里多拦了一层 `!bucket.manual`，
      // 结果是「认不出来的那一组即使指定了目标也不会被搬走」—— 用户看到的是「它就是不搬」，
      // 而摘要里还算进了数量。0.1.61 顺手修掉。
      (bucket) => plan.targets[bucket.key] !== "",
    );
    const total = groups.reduce(
      (sum, bucket) => sum + plan.items.filter((item) => item.bucket === bucket.key).length,
      0,
    );
    for (const bucket of groups) {
      if (signal.aborted) break;
      const target = plan.targets[bucket.key];
      const items = plan.items
        .filter((item) => item.bucket === bucket.key)
        .map((item) => ({ path: item.path, name: item.name, size: item.size }));
      if (items.length === 0) continue;
      // 目标不存在就建（验收清单里明写的一条）。建在**搬之前**：让权限 / 盘满这类错误
      // 在还没动任何文件的时候就冒出来，而不是搬了一半才失败。
      await ctx.makeDir(target);
      const outcome = await runTransfer({
        items,
        destDir: target,
        mode: "move",
        conflict: plan.conflict,
        signal,
        onProgress: (progress) =>
          onProgress({
            label: progress.label,
            done: done + progress.done,
            total,
            bytes: progress.bytes,
            totalBytes: 0,
          }),
      });
      done += outcome.done;
      moved.push(...outcome.moved);
      if (outcome.cancelled || outcome.failure) {
        // 取消（或中途报错）→ **把已经搬过去的搬回去**。改造包点名的第一条：
        // 一半在下载夹、一半在 ROM 目录，是掌机上最难收拾的烂摊子。
        const back = await rollbackTransfer(moved);
        return {
          done,
          skipped: outcome.skipped,
          failed: outcome.failure ? 1 : 0,
          message: outcome.cancelled
            ? text().tasks.cancelledTitle
            : outcome.failure?.message || text().tasks.failTitle,
          rolledBack: back,
        };
      }
    }
    return { done, skipped: 0, failed: 0, message: text().tasks.doneTitle(done) };
  },
};
