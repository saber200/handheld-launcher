/*
 * ⑦ U 盘（改造包 §2.4）。
 *
 * 没插设备时整张卡置灰并说明原因（验收清单第一条）。有设备时就是一个「往哪边搬」的
 * 选择题：往 U 盘传 = 复制过去，从 U 盘导入 = 复制到下载夹。
 *
 * 两个说明：都用**复制**而不是移动（掌机上误拔 U 盘是常事，原文件留着才安全）；
 * 「安全弹出」需要新的 Rust 原语，本版不做 —— 卡片上如实说明，不做点了没反应的按钮。
 */
import { text } from "../../i18n";
import { externalDrives, formatBytes } from "./env";
import { commonSources } from "./sources";
import { runTransfer } from "./transfer";
import type { TaskDef, TaskScan, TaskScanItem } from "./types";

export const usb: TaskDef = {
  id: "usb",
  accent: "accent",
  usesConflict: true,
  card: () => text().tasks.cards.usb,

  unavailable(runtime) {
    return runtime.external.length === 0 ? text().tasks.optNoDevice : null;
  },

  async source(ctx) {
    const options: { value: string; label: string }[] = [];
    for (const drive of await externalDrives(ctx)) {
      options.push({ value: drive.path, label: text().tasks.srcDevice(drive.name) });
    }
    // 设备排前面：这个任务的名字就叫「U 盘」。
    const common = await commonSources(ctx);
    for (const row of common) {
      if (!options.some((entry) => entry.value === row.value)) options.push(row);
    }
    return {
      label: text().tasks.cards.usb.title,
      value: options[0]?.value ?? "",
      options,
      hint: text().tasks.sourceBody,
    };
  },

  async scan(ctx, source): Promise<TaskScan> {
    const rows = await ctx.list(source);
    const items: TaskScanItem[] = rows
      .filter((row) => !row.hidden)
      .map((row) => ({
        path: row.path,
        name: row.name,
        size: row.bytes,
        bucket: "usb",
      }));
    const total = items.reduce((sum, item) => sum + item.size, 0);
    return {
      items,
      buckets: [
        {
          key: "usb",
          label: text().tasks.cards.usb.title,
          target: "",
          targetLabel: text().tasks.optPickDevice,
          color: "accent",
          manual: true,
        },
      ],
      note: text().tasks.resultMeta(items.length, formatBytes(total)),
    };
  },

  async fields(ctx, scan) {
    const devices = await externalDrives(ctx);
    const device = devices[0]?.path ?? "";
    const options = [
      {
        value: ACTION.toDevice,
        label: text().tasks.usbToDevice,
        hint: text().tasks.usbToDeviceHint,
      },
      {
        value: ACTION.fromDevice,
        label: text().tasks.usbFromDevice,
        hint: text().tasks.usbFromDeviceHint,
      },
    ];
    const fields: ReturnType<TaskDef["fields"]> = [
      {
        kind: "chips",
        key: "action",
        label: text().tasks.optAction,
        value: ACTION.fromDevice,
        chips: options,
      },
      {
        kind: "target",
        key: "target:usb",
        label: text().tasks.optDevice,
        value: device || ctx.dirs.downloads,
        hint: device ? text().tasks.optEjectHint : text().tasks.optNoDevice,
      },
    ];
    if (scan.items.length > 0) {
      fields.push({
        kind: "checks",
        key: "picked",
        label: text().tasks.optChecks,
        value: scan.items.map((item) => item.path),
        choices: scan.items.slice(0, 200).map((item) => ({
          value: item.path,
          label: item.name,
          hint: formatBytes(item.size),
        })),
      });
    }
    return fields;
  },

  summary(items, plan) {
    const picked = new Set((plan.options.picked as string[] | undefined) ?? items.map((i) => i.path));
    const chosen = items.filter((item) => picked.has(item.path));
    return {
      count: chosen.length,
      totalBytes: chosen.reduce((sum, item) => sum + item.size, 0),
      etaSec: chosen.reduce((sum, item) => sum + item.size, 0) / (20 * 1024 * 1024),
      conflictPolicy: plan.conflict,
      // 掌机的 USB 口多半是 5 Gbps 里跑不满的老实速度；按 20 MB/s 估，宁可报多不报少。
      notes: [text().tasks.optEjectHint],
    };
  },

  async run(ctx, plan, onProgress, signal) {
    const action = (plan.options.action as string | undefined) ?? ACTION.fromDevice;
    const picked = new Set(
      (plan.options.picked as string[] | undefined) ?? plan.items.map((item) => item.path),
    );
    const items = plan.items.filter((item) => picked.has(item.path));
    const target = plan.targets.usb || ctx.dirs.downloads;
    if (items.length === 0) {
      return { done: 0, skipped: 0, failed: 0, message: text().tasks.optNothing };
    }
    await ctx.makeDir(target);
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
          total: items.length,
          bytes: progress.bytes,
          totalBytes: 0,
        }),
    });
    const verb = action === ACTION.toDevice ? text().tasks.usbToDevice : text().tasks.usbFromDevice;
    return {
      done: outcome.done,
      skipped: outcome.skipped,
      failed: outcome.failure ? 1 : 0,
      message: outcome.cancelled
        ? text().tasks.cancelledTitle
        : outcome.failure?.message || `${verb} · ${text().tasks.doneTitle(outcome.done)}`,
    };
  },
};

const ACTION = { toDevice: "toDevice", fromDevice: "fromDevice" } as const;
