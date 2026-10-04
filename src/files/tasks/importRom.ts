/*
 * ① 导入 ROM（改造包 §2.4）。
 *
 * 用户想的是「我把 ROM 丢进下载夹了，帮我装进模拟器」，不是「我要把文件从 A 移到 B」。
 * 所以这里只问一件事：从哪个文件夹开始找？剩下的分类、目标、模拟器都由表决定。
 */
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
    return { items, buckets, note: text().tasks.resultMeta(items.length, formatBytes(total)) };
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
    const counted = items.filter((item) => item.bucket !== UNKNOWN && target(item) !== "");
    const totalBytes = counted.reduce((sum, item) => sum + item.size, 0);
    const notes = [text().tasks.sumEstimate];
    if (plan.conflict === "replace") {
      // 被覆盖掉的旧文件是**回滚不了**的：先把话说明白，别等用户取消了才发现。
      notes.push(text().tasks.replaceNoRollback);
    }
    if (items.some((item) => item.bucket === UNKNOWN)) notes.push(text().tasks.unknownHint);
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
      (bucket) => plan.targets[bucket.key] && !bucket.manual,
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
