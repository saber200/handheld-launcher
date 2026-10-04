/*
 * ⑤ 处理截图（改造包 §2.4）。
 *
 * 三种动作走三条既有命令：导出（`file_transfer` 复制）、压缩归档（`file_compress`）、
 * 批量删除（`file_delete`，**永久删除**，所以摘要里必须写明不进回收站）。
 */
import { invoke } from "@tauri-apps/api/core";
import { text } from "../../i18n";
import { externalDrives, formatBytes, formatTime, joinPath } from "./env";
import { commonSources } from "./sources";
import { runTransfer } from "./transfer";
import type { TaskDef, TaskScan, TaskScanItem } from "./types";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".mp4"];

/** 三种动作的键（同时也是 `plan.options.action` 的值）。 */
const ACTION = { export: "export", archive: "archive", delete: "delete" } as const;

export const exportShots: TaskDef = {
  id: "exportShots",
  accent: "warning",
  usesConflict: true,
  card: () => text().tasks.cards.exportShots,

  unavailable() {
    return null;
  },

  async source(ctx) {
    const options = await commonSources(ctx, [
      { value: ctx.dirs.shots, label: text().tasks.srcShots },
      { value: joinPath(ctx.dirs.pictures, "Screenshots"), label: "Screenshots" },
      {
        value: joinPath(joinPath(ctx.dirs.home, "Videos"), "Captures"),
        label: text().tasks.srcCaptures,
      },
    ]);
    return {
      label: text().tasks.cards.exportShots.title,
      value: options[0]?.value ?? "",
      options,
      hint: text().tasks.sourceBody,
    };
  },

  async scan(ctx, source): Promise<TaskScan> {
    const rows = await ctx.list(source);
    const items: TaskScanItem[] = [];
    let oldest = 0;
    for (const row of rows) {
      if (row.kind !== "file" || row.hidden) continue;
      const lower = row.name.toLowerCase();
      if (!IMAGE_EXTS.some((ext) => lower.endsWith(ext))) continue;
      items.push({
        path: row.path,
        name: row.name,
        size: row.bytes,
        bucket: "shots",
        meta: { modified: row.modified },
      });
      if (row.modified && (oldest === 0 || row.modified < oldest)) oldest = row.modified;
    }
    const total = items.reduce((sum, item) => sum + item.size, 0);
    const note = `${text().tasks.resultMeta(items.length, formatBytes(total))}${
      oldest ? ` · ${formatTime(oldest)}` : ""
    }`;
    return {
      items,
      buckets: [
        {
          key: "shots",
          label: text().tasks.cards.exportShots.title,
          target: "",
          targetLabel: text().tasks.optAction,
          color: "warning",
        },
      ],
      note,
    };
  },

  async fields(ctx, scan) {
    const devices = await externalDrives(ctx);
    const device = devices[0]?.path ?? "";
    return [
      {
        kind: "chips" as const,
        key: "action",
        label: text().tasks.optAction,
        value: ACTION.export,
        chips: [
          { value: ACTION.export, label: text().tasks.shotsExport, hint: text().tasks.usbToDeviceHint },
          { value: ACTION.archive, label: text().tasks.shotsArchive },
          { value: ACTION.delete, label: text().tasks.shotsDelete, hint: text().tasks.optDeleteWarning },
        ],
      },
      {
        kind: "target" as const,
        key: "target:shots",
        label: text().tasks.previewLocation,
        value: device || ctx.dirs.downloads,
        hint: device ? undefined : text().tasks.optNoDevice,
      },
      ...(scan.items.length === 0
        ? []
        : [
            {
              kind: "checks" as const,
              key: "picked",
              label: text().tasks.optChecks,
              value: scan.items.map((item) => item.path),
              choices: scan.items.slice(0, 200).map((item) => ({
                value: item.path,
                label: item.name,
                hint: formatBytes(item.size),
              })),
            },
          ]),
    ];
  },

  summary(items, plan) {
    const picked = new Set((plan.options.picked as string[] | undefined) ?? items.map((i) => i.path));
    const chosen = items.filter((item) => picked.has(item.path));
    const totalBytes = chosen.reduce((sum, item) => sum + item.size, 0);
    const action = (plan.options.action as string | undefined) ?? ACTION.export;
    const notes = [text().tasks.sumEstimate];
    if (action === ACTION.delete) notes.push(text().tasks.optDeleteWarning);
    return {
      count: chosen.length,
      totalBytes,
      etaSec: (totalBytes * 2) / (45 * 1024 * 1024),
      conflictPolicy: plan.conflict,
      notes,
    };
  },

  async run(ctx, plan, onProgress, signal) {
    const action = (plan.options.action as string | undefined) ?? ACTION.export;
    const picked = new Set(
      (plan.options.picked as string[] | undefined) ?? plan.items.map((item) => item.path),
    );
    const items = plan.items.filter((item) => picked.has(item.path));
    const total = items.length;
    let done = 0;
    let failed = 0;

    if (action === ACTION.delete) {
      for (const item of items) {
        if (signal.aborted) break;
        onProgress({ label: item.name, done, total, bytes: 0, totalBytes: 0 });
        try {
          // 不再弹二次确认：摘要页已经把「删了就没了」摆在最显眼的位置，
          // 而这些项是用户自己勾的、开始键也是他按的。
          await invoke("file_delete", { path: item.path, permanent: true });
          done += 1;
        } catch {
          failed += 1;
        }
      }
      return { done, skipped: 0, failed, message: text().tasks.doneTitle(done) };
    }

    const target = plan.targets.shots;
    if (!target) {
      return { done: 0, skipped: 0, failed: items.length, message: text().tasks.targetMissing };
    }
    await ctx.makeDir(target);

    if (action === ACTION.archive) {
      try {
        // 截图都在同一个目录里，正好符合 `file_compress` 的要求；zip 先落在截图目录旁边，
        // 再搬进目标目录 —— 免得打包到一半失败时在 U 盘上留下半个包。
        const out = await invoke<{ archive: string }>("file_compress", {
          paths: items.map((item) => item.path),
          name: `shots-${new Date().toISOString().slice(0, 10)}`,
        });
        onProgress({ label: out.archive, done: 0, total: 1, bytes: 0, totalBytes: 0 });
        const moved = await runTransfer({
          items: [
            { path: out.archive, name: out.archive.split(/[\\/]/).pop() ?? "shots.zip", size: 0 },
          ],
          destDir: target,
          mode: "move",
          conflict: "keepBoth",
          signal,
          onProgress: () => undefined,
        });
        if (moved.done === 0 && moved.failure) {
          return { done: 0, skipped: 0, failed: 1, message: moved.failure.message };
        }
        return { done: 1, skipped: 0, failed: 0, message: text().tasks.doneTitle(1) };
      } catch (err) {
        const info = err as { message?: string } | null;
        return { done: 0, skipped: 0, failed: 1, message: info?.message ?? text().tasks.failTitle };
      }
    }

    // 导出：**复制**（不是移动）。掌机上把截图搬走、U 盘却没插稳，是最亏的一种失败。
    const outcome = await runTransfer({
      items: items.map((item) => ({ path: item.path, name: item.name, size: item.size })),
      destDir: target,
      mode: "copy",
      conflict: plan.conflict,
      signal,
      onProgress: (progress) =>
        onProgress({
          label: progress.label,
          done: progress.done,
          total,
          bytes: progress.bytes,
          totalBytes: 0,
        }),
    });
    done = outcome.done;
    failed = outcome.failure ? 1 : 0;
    return {
      done,
      skipped: outcome.skipped,
      failed,
      message: outcome.cancelled
        ? text().tasks.cancelledTitle
        : outcome.failure?.message || text().tasks.doneTitle(done),
    };
  },
};
