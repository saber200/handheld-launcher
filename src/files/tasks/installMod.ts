/*
 * ② 安装 Mod / 工具（改造包 §2.4）。
 *
 * 与「导入 ROM」的区别：那个是「文件去哪」，这个是「东西装进已装的游戏里」。
 * 所以第 2 步先给出游戏列表让用户点，而不是让他自己想安装目录。
 *
 * 解压用现有 `file_extract`：它把包解到**包旁边的临时目录**里，所以流程是三段
 * 「解压 → （按需）去掉一层 → 把内容搬进游戏目录 → 删掉临时目录」。
 */
import { invoke } from "@tauri-apps/api/core";
import { text } from "../../i18n";
import { formatBytes } from "./env";
import { commonSources } from "./sources";
import { rollbackTransfer, runTransfer } from "./transfer";
import type { TaskDef, TaskScan, TaskScanItem } from "./types";

const ARCHIVE_EXTS = [".zip", ".7z"];

function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTS.some((ext) => lower.endsWith(ext));
}

export const installMod: TaskDef = {
  id: "installMod",
  accent: "accent-2",
  usesConflict: true,
  card: () => text().tasks.cards.installMod,

  unavailable() {
    return null;
  },

  async source(ctx) {
    const options = await commonSources(ctx);
    return {
      label: text().tasks.cards.installMod.title,
      value: options[0]?.value ?? "",
      options,
      hint: text().tasks.sourceBody,
    };
  },

  async scan(ctx, source): Promise<TaskScan> {
    const rows = await ctx.list(source);
    const items: TaskScanItem[] = [];
    for (const row of rows) {
      if (row.kind !== "file" || row.hidden || !isArchive(row.name)) continue;
      items.push({
        path: row.path,
        name: row.name,
        size: row.bytes,
        bucket: "archive",
        meta: { archive: row.path },
      });
    }
    const total = items.reduce((sum, item) => sum + item.size, 0);
    return {
      items,
      buckets: [
        {
          key: "archive",
          label: text().tasks.cards.installMod.title,
          target: "",
          targetLabel: text().tasks.optGame,
          color: "accent-2",
          manual: true,
          hint: text().tasks.optGameAuto,
        },
      ],
      note: text().tasks.resultMeta(items.length, formatBytes(total)),
    };
  },

  async fields(ctx, scan) {
    const games = await ctx.games();
    const fields: ReturnType<TaskDef["fields"]> = [];
    if (games.length > 0) {
      // 先给游戏列表：掌机上「点一个名字」永远比「翻目录找一个路径」快。
      fields.push({
        kind: "chips",
        key: "game",
        label: text().tasks.optTarget,
        value: "",
        target: "archive",
        chips: games.slice(0, 12).map((game) => ({ value: game.installPath, label: game.name })),
      });
    }
    fields.push({
      kind: "target",
      key: "target:archive",
      label: text().tasks.optGame,
      value: scan.buckets[0]?.target ?? "",
      hint: games.length === 0 ? text().tasks.optGameAuto : undefined,
    });
    return fields;
  },

  summary(items, plan) {
    const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
    const notes = [text().tasks.optStripped, text().tasks.sumEstimate];
    if (plan.conflict === "replace") notes.push(text().tasks.replaceNoRollback);
    return {
      count: items.length,
      totalBytes,
      // 解压 + 再搬一遍，按一半速度算：压缩包的读入与写盘是两趟。
      etaSec: (totalBytes * 2) / (45 * 1024 * 1024),
      conflictPolicy: plan.conflict,
      notes,
    };
  },

  async run(ctx, plan, onProgress, signal) {
    const target = plan.targets.archive;
    if (!target) {
      return {
        done: 0,
        skipped: 0,
        failed: plan.items.length,
        message: text().tasks.targetMissing,
      };
    }
    // 装之前把游戏目录建出来：连目录都没有的游戏，说明目标选错了，越早报越好。
    await ctx.makeDir(target);
    const total = plan.items.length;
    const moved: { from: string; to: string }[] = [];
    let done = 0;
    let failed = 0;
    for (const item of plan.items) {
      if (signal.aborted) break;
      onProgress({ label: item.name, done, total, bytes: 0, totalBytes: 0 });
      let extracted: { dir: string };
      try {
        // 现有命令把包解到**包旁边的临时目录**，所以下面还要把内容搬进游戏目录。
        extracted = await invoke<{ dir: string }>("file_extract", { archive: item.path });
      } catch {
        failed += 1;
        continue;
      }
      const rows = await ctx.list(extracted.dir);
      // 「压缩包顶层只有一个目录就去掉一层」：这是 Mod 包最常见的结构
      // （`MyMod\data\...`），不去掉的话游戏目录里会多一层没用的壳。
      const payload =
        rows.length === 1 && rows[0].kind === "dir" ? rows[0].path : extracted.dir;
      const children = (await ctx.list(payload)).map((row) => ({
        path: row.path,
        name: row.name,
        size: row.bytes,
      }));
      if (children.length > 0) {
        const outcome = await runTransfer({
          items: children,
          destDir: target,
          mode: "move",
          conflict: plan.conflict,
          signal,
          onProgress: (progress) =>
            onProgress({
              label: progress.label,
              done,
              total,
              bytes: progress.bytes,
              totalBytes: 0,
            }),
        });
        moved.push(...outcome.moved);
        done += outcome.done;
        if (outcome.cancelled || outcome.failure) {
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
      // 收尾：临时目录空了就删掉。删不掉（里面还有东西）就留着 —— 用户看得见，
      // 比「我们偷偷递归删了一个目录」安全得多。
      try {
        await invoke("file_delete", { path: extracted.dir, permanent: true });
      } catch {
        /* 留着 */
      }
    }
    return { done, skipped: 0, failed, message: text().tasks.doneTitle(done) };
  },
};
