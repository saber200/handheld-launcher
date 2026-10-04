/*
 * ④ 恢复存档（改造包 §2.4）：③ 的逆操作。
 *
 * **覆盖前先备份**是这个任务的底线。掌机上误操作一次就是几十小时存档，
 * 所以任何「要盖掉的东西」都先改名加 `.bak`，绝不直接覆盖。
 */
import { invoke } from "@tauri-apps/api/core";
import { text } from "../../i18n";
import { formatBytes, joinPath, parentOf } from "./env";
import { rollbackTransfer, runTransfer } from "./transfer";
import type { TaskCtx, TaskDef, TaskScan, TaskScanItem } from "./types";

/** 目标已存在时挑一个不撞车的 `.bak` 名字（`.bak` / `.bak2` / `.bak3`…）。 */
async function freeBakName(ctx: TaskCtx, target: string): Promise<string> {
  const siblings = await ctx.list(parentOf(target));
  const names = new Set(siblings.map((row) => row.name.toLowerCase()));
  const leaf = target.split(/[\\/]/).pop() ?? target;
  for (let index = 1; index <= 50; index += 1) {
    const candidate = index === 1 ? `${leaf}.bak` : `${leaf}.bak${index}`;
    if (!names.has(candidate.toLowerCase())) return joinPath(parentOf(target), candidate);
  }
  return `${target}.bak`;
}

export const restoreSaves: TaskDef = {
  id: "restoreSaves",
  accent: "warning",
  usesConflict: false,
  card: () => text().tasks.cards.restoreSaves,

  unavailable() {
    return null;
  },

  async source(ctx) {
    const options: { value: string; label: string }[] = [];
    if (ctx.dirs.backups) {
      options.push({ value: ctx.dirs.backups, label: text().tasks.srcBackups });
      // 备份根下的每个日期文件夹都是一个可选来源 —— 用户想恢复的往往是「三天前那次」。
      try {
        const rows = await ctx.list(ctx.dirs.backups);
        for (const row of rows) {
          if (row.kind === "dir") options.push({ value: row.path, label: row.name });
        }
      } catch {
        /* 备份目录还没有：只留根目录一项，扫描时会如实说它是空的 */
      }
    }
    return {
      label: text().tasks.cards.restoreSaves.title,
      value: options[0]?.value ?? "",
      options,
      hint: text().tasks.sourceBody,
    };
  },

  async scan(ctx, source): Promise<TaskScan> {
    const rows = await ctx.list(source);
    const items: TaskScanItem[] = [];
    for (const row of rows) {
      if (row.kind !== "file" || !row.name.toLowerCase().endsWith(".zip")) continue;
      items.push({
        path: row.path,
        name: row.name,
        size: row.bytes,
        bucket: "restore",
        meta: { game: row.name.replace(/\.zip$/i, "") },
      });
    }
    const total = items.reduce((sum, item) => sum + item.size, 0);
    return {
      items,
      buckets: [
        {
          key: "restore",
          label: text().tasks.cards.restoreSaves.title,
          target: "",
          targetLabel: text().tasks.optGame,
          color: "warning",
          manual: true,
          hint: text().tasks.optBakNote,
        },
      ],
      note: text().tasks.resultMeta(items.length, formatBytes(total)),
    };
  },

  fields(_ctx, scan) {
    return [
      {
        kind: "target" as const,
        key: "target:restore",
        label: text().tasks.optGame,
        value: scan.buckets[0]?.target ?? "",
        hint: text().tasks.optBakNote,
      },
      {
        kind: "checks" as const,
        key: "picked",
        label: text().tasks.optChecks,
        value: scan.items.map((item) => item.path),
        choices: scan.items.map((item) => ({
          value: item.path,
          label: item.name.replace(/\.zip$/i, ""),
          hint: formatBytes(item.size),
        })),
      },
    ];
  },

  summary(items, plan) {
    const picked = new Set((plan.options.picked as string[] | undefined) ?? items.map((i) => i.path));
    const chosen = items.filter((item) => picked.has(item.path));
    const totalBytes = chosen.reduce((sum, item) => sum + item.size, 0);
    return {
      count: chosen.length,
      totalBytes,
      etaSec: (totalBytes * 2) / (45 * 1024 * 1024),
      conflictPolicy: plan.conflict,
      notes: [text().tasks.optBakNote, text().tasks.sumEstimate],
    };
  },

  async run(ctx, plan, onProgress, signal) {
    const target = plan.targets.restore;
    if (!target) {
      return { done: 0, skipped: 0, failed: plan.items.length, message: text().tasks.targetMissing };
    }
    const picked = new Set(
      (plan.options.picked as string[] | undefined) ?? plan.items.map((item) => item.path),
    );
    const items = plan.items.filter((item) => picked.has(item.path));
    const total = items.length;
    const moved: { from: string; to: string }[] = [];
    let done = 0;
    let failed = 0;
    let backedUp = false;
    for (const item of items) {
      if (signal.aborted) break;
      onProgress({ label: item.name, done, total, bytes: 0, totalBytes: 0 });
      let extracted: { dir: string };
      try {
        extracted = await invoke<{ dir: string }>("file_extract", { archive: item.path });
      } catch {
        failed += 1;
        continue;
      }
      // 覆盖前先留底：把现有存档目录改名加 .bak。**只做一次** —— 多个包恢复进同一个
      // 游戏目录时，第二次改名会把第一次的 .bak 一起卷进去，越滚越大。
      const hasExisting = await ctx
        .list(target)
        .then((rows) => rows.length > 0)
        .catch(() => false);
      if (hasExisting && !backedUp) {
        const bak = await freeBakName(ctx, target);
        try {
          await invoke("file_rename", { from: target, to: bak });
          backedUp = true;
        } catch {
          // 改名失败（占用 / 权限）就别往下走了：宁可不恢复，也不能把存档盖掉。
          return {
            done,
            skipped: 0,
            failed: items.length - done,
            message: text().tasks.optBakNote,
          };
        }
      }
      await ctx.makeDir(target);
      const rows = await ctx.list(extracted.dir);
      const payload = rows.length === 1 && rows[0].kind === "dir" ? rows[0].path : extracted.dir;
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
          // 备份刚整目录留过底，这里再逐个问「同名怎么办」没有意义。
          conflict: "replace",
          signal,
          onProgress: (progress) =>
            onProgress({ label: progress.label, done, total, bytes: progress.bytes, totalBytes: 0 }),
        });
        moved.push(...outcome.moved);
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
      try {
        await invoke("file_delete", { path: extracted.dir, permanent: true });
      } catch {
        /* 临时目录里还有东西就留着 */
      }
      done += 1;
    }
    return { done, skipped: 0, failed, message: text().tasks.doneTitle(done) };
  },
};
