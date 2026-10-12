/*
 * ③ 备份游戏存档（改造包 §2.4）。
 *
 * 不需要用户挑来源（来源是「这台机器上装了哪些游戏」），所以第 1 步会跳过，直接进扫描。
 *
 * 打包方式：**每处存档各打一个 zip**，再把它搬进 `<数据盘>\Backups\Saves\<日期>\`。
 * 为什么不把几处存档打成一个包：现有 `file_compress` 要求所有条目在同一个目录里
 * （zip 就放在那个目录），而存档散落在 Documents / APPDATA / 模拟器目录下 ——
 * 硬凑一个包得先把它们拷到临时目录，等于白拷一遍。
 */
import { invoke } from "@tauri-apps/api/core";
import { text } from "../../i18n";
import { formatBytes, joinPath } from "./env";
import { rollbackTransfer, runTransfer } from "./transfer";
import type { TaskCtx, TaskDef, TaskScan, TaskScanItem } from "./types";

/** 一处候选存档目录：名字 + 路径。 */
type Candidate = { label: string; path: string };

/** 第一处能列出来的目录（`file_list` 失败 = 不存在 / 没权限）。 */
async function firstExisting(ctx: TaskCtx, paths: string[]): Promise<string> {
  for (const path of paths) {
    if (!path) continue;
    try {
      await ctx.list(path);
      return path;
    } catch {
      continue;
    }
  }
  return "";
}

export const backupSaves: TaskDef = {
  id: "backupSaves",
  accent: "violet",
  usesConflict: false,
  card: () => text().tasks.cards.backupSaves,

  unavailable() {
    return null;
  },

  /** 来源就是「这台机器」，不用挑。 */
  async source() {
    return null;
  },

  async scan(ctx): Promise<TaskScan> {
    const candidates: Candidate[] = [];
    const add = (label: string, path: string) => {
      if (path && !candidates.some((row) => row.path === path)) candidates.push({ label, path });
    };
    const games = await ctx.games();
    for (const game of games.slice(0, 40)) {
      const hit = await firstExisting(ctx, [
        joinPath(ctx.dirs.roaming, game.name),
        joinPath(ctx.dirs.localAppData, game.name),
        joinPath(ctx.dirs.myGames, game.name),
        joinPath(ctx.dirs.documents, game.name),
      ]);
      if (hit) add(game.name, hit);
    }
    // 模拟器的存档不在游戏名下面，单独补两条（改造包点名的两个）。
    // Eden（Switch 模拟器）：便携模式下存档在程序目录的 `user/nand`，非便携才在 %APPDATA%\eden。
    // 这里报的是后者的默认位置 —— 和上面几条一样，只求「扫得到」，不替用户猜便携目录在哪。
    add("Eden", joinPath(joinPath(ctx.dirs.roaming, "eden"), "nand"));
    add("Citra", joinPath(joinPath(ctx.dirs.roaming, "Citra"), "saves"));
    const items: TaskScanItem[] = [];
    for (const row of candidates) {
      const size = await ctx.measure(row.path);
      items.push({
        path: row.path,
        name: row.label,
        size: size.bytes,
        bucket: "saves",
        meta: { complete: size.complete ? 1 : 0 },
      });
    }
    const total = items.reduce((sum, item) => sum + item.size, 0);
    return {
      items,
      buckets: [
        {
          key: "saves",
          label: text().tasks.cards.backupSaves.title,
          target: joinPath(ctx.dirs.backups, new Date().toISOString().slice(0, 10)),
          targetLabel: text().tasks.srcBackups,
          color: "violet",
        },
      ],
      note: `${text().tasks.optSaveCount(items.length)} · ${formatBytes(total)}`,
    };
  },

  fields(ctx, scan) {
    void ctx;
    return [
      {
        kind: "target" as const,
        key: "target:saves",
        label: text().tasks.srcBackups,
        value: scan.buckets[0]?.target ?? "",
        hint: text().tasks.targetNew,
      },
      {
        kind: "checks" as const,
        key: "picked",
        label: text().tasks.optChecks,
        value: scan.items.map((item) => item.path),
        choices: scan.items.map((item) => ({
          value: item.path,
          label: item.name,
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
      // 压缩是 CPU 活，比搬文件慢得多：按一半速度估。
      etaSec: (totalBytes * 2) / (45 * 1024 * 1024),
      conflictPolicy: plan.conflict,
      notes: [text().tasks.sumEstimate],
    };
  },

  async run(ctx, plan, onProgress, signal) {
    const target = plan.targets.saves;
    const picked = new Set(
      (plan.options.picked as string[] | undefined) ?? plan.items.map((item) => item.path),
    );
    const items = plan.items.filter((item) => picked.has(item.path));
    if (!target) {
      return { done: 0, skipped: 0, failed: items.length, message: text().tasks.targetMissing };
    }
    await ctx.makeDir(target);
    const total = items.length;
    const moved: { from: string; to: string }[] = [];
    let done = 0;
    let failed = 0;
    for (const item of items) {
      if (signal.aborted) break;
      onProgress({ label: item.name, done, total, bytes: 0, totalBytes: 0 });
      let archive = "";
      try {
        // 一处存档一个 zip（见文件头的说明：现有 `file_compress` 只吃同一个目录下的条目）。
        const out = await invoke<{ archive: string }>("file_compress", {
          paths: [item.path],
          name: item.name,
        });
        archive = out.archive;
      } catch {
        failed += 1;
        continue;
      }
      const outcome = await runTransfer({
        items: [{ path: archive, name: archive.split(/[\\/]/).pop() ?? item.name, size: 0 }],
        destDir: target,
        mode: "move",
        conflict: "skip",
        signal,
        onProgress: (progress) =>
          onProgress({ label: progress.label, done, total, bytes: 0, totalBytes: 0 }),
      });
      moved.push(...outcome.moved);
      if (outcome.cancelled || outcome.failure) {
        // 取消：把已经搬进备份目录的 zip 搬回去（zip 就留在存档目录旁边，用户看得见）。
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
      done += 1;
    }
    return { done, skipped: 0, failed, message: text().tasks.doneTitle(done) };
  },
};
