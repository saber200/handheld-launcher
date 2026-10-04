/*
 * ⑦ U 盘（改造包 §2.4）。
 *
 * 没插设备时整张卡置灰并说明原因（验收清单第一条）。有设备时就是一个「往哪边搬」的
 * 选择题：往 U 盘传 = 复制过去，从 U 盘导入 = 复制到下载夹。
 *
 * 两个说明：
 *   - 都用**复制**而不是移动（掌机上误拔 U 盘是常事，原文件留着才安全）；
 *   - 「安全弹出」现在是真的了（0.1.61，功能 15 第 2 条）：勾上「搬完自动弹出」就调
 *     `file_eject`（锁卷 → 卸载 → 弹介质）。**默认不勾** —— 用户可能还要接着拷第二趟，
 *     替他拔掉是一厢情愿。弹不出来就把系统给的原因原样报出来（多半是资源管理器还开着
 *     那块盘的窗口）。
 */
import { invoke } from "@tauri-apps/api/core";
import { text } from "../../i18n";
import { externalDrives, formatBytes } from "./env";
import { commonSources } from "./sources";
import { runTransfer } from "./transfer";
import type { TaskDef, TaskScan, TaskScanItem } from "./types";

/** 勾选项的值：搬完自动弹出。 */
const EJECT = "eject";

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
      {
        // 一个勾选框 = 一个开关。`checks` 是现成的多选字段（值是个数组），
        // 只放一个选项就是开关；默认空数组 = 不勾。
        kind: "checks",
        key: "eject",
        label: text().tasks.usbEject,
        value: [],
        hint: text().tasks.usbEjectAfterHint,
        choices: [{ value: EJECT, label: text().tasks.usbEjectAfter }],
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
    const notes = [text().tasks.optEjectHint];
    // 勾了自动弹出就把「它会弹」写进摘要：用户在第 3 步该看到这一趟会动到硬件。
    if (((plan.options.eject as string[] | undefined) ?? []).includes(EJECT)) {
      notes.push(text().tasks.usbEjectAfterHint);
    }
    return {
      count: chosen.length,
      totalBytes: chosen.reduce((sum, item) => sum + item.size, 0),
      etaSec: chosen.reduce((sum, item) => sum + item.size, 0) / (20 * 1024 * 1024),
      conflictPolicy: plan.conflict,
      // 掌机的 USB 口多半是 5 Gbps 里跑不满的老实速度；按 20 MB/s 估，宁可报多不报少。
      notes,
    };
  },

  async run(ctx, plan, onProgress, signal) {
    const action = (plan.options.action as string | undefined) ?? ACTION.fromDevice;
    const ejectWanted =
      action === ACTION.toDevice &&
      ((plan.options.eject as string[] | undefined) ?? []).includes(EJECT);
    const picked = new Set(
      (plan.options.picked as string[] | undefined) ?? plan.items.map((item) => item.path),
    );
    const items = plan.items.filter((item) => picked.has(item.path));
    const target = plan.targets.usb || ctx.dirs.downloads;
    if (items.length === 0 && !ejectWanted) {
      return { done: 0, skipped: 0, failed: 0, message: text().tasks.optNothing };
    }
    let done = 0;
    let skipped = 0;
    let failure: string | undefined;
    if (items.length > 0) {
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
      done = outcome.done;
      skipped = outcome.skipped;
      failure = outcome.failure?.message;
      if (outcome.cancelled) {
        return { done, skipped, failed: 0, message: text().tasks.cancelledTitle };
      }
      // 搬失败了就别弹：用户手上还有个要收拾的烂摊子，这时候把盘拔掉更麻烦。
      if (failure) {
        return { done, skipped, failed: 1, message: failure };
      }
    }
    const verb = action === ACTION.toDevice ? text().tasks.usbToDevice : text().tasks.usbFromDevice;
    const ejected = ejectWanted ? await ejectDevice(target) : null;
    const parts = [`${verb} · ${text().tasks.doneTitle(done)}`];
    // 弹出成功 / 失败都如实写进结果：失败时把系统给的原因带出来，
    // 这是「点了没反应」和「告诉你为什么」的区别。
    if (ejected) parts.push(ejected);
    return { done, skipped, failed: failure ? 1 : 0, message: parts.join(" · ") };
  },
};

/**
 * 安全弹出一块盘。返回一句给用户看的结果（成功或失败的原因），
 * 不是盘符（`E:\`）就直接返回 `null` —— 那种情况下没有可弹出的东西。
 */
async function ejectDevice(target: string): Promise<string | null> {
  const match = /^([A-Za-z]):[\\/]*$/.exec(target.trim());
  if (!match) return null;
  try {
    await invoke("file_eject", { drive: `${match[1]}:` });
    return text().tasks.usbEjectDone;
  } catch (err) {
    const info = err as { message?: string } | null;
    return info?.message || text().tasks.jobsFailed;
  }
}

const ACTION = { toDevice: "toDevice", fromDevice: "fromDevice" } as const;
