/*
 * ⑥ 清理空间（改造包 §2.4）。
 *
 * 用户的问题是「盘满了，删什么」，不是「给我一个文件管理器」。所以这里按**体积**列出
 * 能删的东西，默认**一个都不勾**（验收清单里明写的一条）—— 默认勾上就等于替用户决定
 * 要删东西。
 *
 * 回收站没做：清空回收站要一个新的 Rust 原语（改造包只允许加 `file_thumb`）。
 * 与其做一个点了没反应的按钮，不如不列（已记进 FUTURE.md）。
 */
import { invoke } from "@tauri-apps/api/core";
import { text } from "../../i18n";
import { formatBytes, joinPath, nameOf } from "./env";
import type { TaskBucket, TaskDef, TaskScan, TaskScanItem } from "./types";

const OLD_INSTALLER_EXTS = [".exe", ".msi", ".zip", ".7z", ".rar"];
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Steam 的着色器缓存：从已装游戏的安装路径反推（`...\steamapps\common\<game>`）。 */
function steamShaderCache(installPath: string): string {
  const marker = installPath.toLowerCase().indexOf("steamapps");
  if (marker < 0) return "";
  return joinPath(installPath.slice(0, marker + "steamapps".length), "shadercache");
}

type Candidate = { path: string; label: string; size: number; bucket: string };

export const cleanup: TaskDef = {
  id: "cleanup",
  accent: "accent-2",
  usesConflict: false,
  card: () => text().tasks.cards.cleanup,

  unavailable() {
    return null;
  },

  /** 不用挑来源：可清理的东西都在固定几处。 */
  async source() {
    return null;
  },

  async scan(ctx): Promise<TaskScan> {
    const t = text().tasks;
    const candidates: Candidate[] = [];

    // ① 旧安装包（下载夹里 30 天前的 exe / msi / zip）
    if (ctx.dirs.downloads) {
      try {
        const rows = await ctx.list(ctx.dirs.downloads);
        const now = Date.now();
        for (const row of rows) {
          if (row.kind !== "file") continue;
          const lower = row.name.toLowerCase();
          if (!OLD_INSTALLER_EXTS.some((ext) => lower.endsWith(ext))) continue;
          if (!row.modified || now - row.modified < THIRTY_DAYS_MS) continue;
          candidates.push({
            path: row.path,
            label: row.name,
            size: row.bytes,
            bucket: "installers",
          });
        }
      } catch {
        /* 下载夹读不了就少一类，如实体现在结果里 */
      }
    }

    // ② 疑似重复截图（同尺寸 + 同后缀，留下最早的那张）
    for (const dir of [ctx.dirs.shots, ctx.dirs.pictures]) {
      if (!dir) continue;
      try {
        const rows = await ctx.list(dir);
        const seen = new Map<string, string>();
        for (const row of rows) {
          if (row.kind !== "file") continue;
          const lower = row.name.toLowerCase();
          if (!/\.(png|jpg|jpeg|webp|bmp)$/.test(lower)) continue;
          const key = `${row.bytes}:${lower.slice(lower.lastIndexOf("."))}`;
          const first = seen.get(key);
          if (!first) {
            seen.set(key, row.name);
            continue;
          }
          candidates.push({
            path: row.path,
            label: `${row.name} （与 ${first} 同尺寸）`,
            size: row.bytes,
            bucket: "dupShots",
          });
        }
      } catch {
        /* 没有这个目录 */
      }
    }

    // ③ 日志（启动器自己的日志目录；不翻游戏日志 —— 那是游戏自己的事）
    try {
      const rows = await ctx.list(joinPath(ctx.dirs.roaming, "handheld-launcher"));
      for (const row of rows) {
        if (row.kind !== "file" || !row.name.toLowerCase().endsWith(".log")) continue;
        candidates.push({ path: row.path, label: row.name, size: row.bytes, bucket: "logs" });
      }
    } catch {
      /* 还没写过日志 */
    }

    // ④ 着色器缓存（Steam）：删了会重新编译、不碰存档，是掌机上最值得清的一类
    const caches = new Set<string>();
    for (const game of (await ctx.games()).slice(0, 40)) {
      const cache = steamShaderCache(game.installPath);
      if (cache) caches.add(cache);
    }
    for (const cache of caches) {
      const size = await ctx.measure(cache);
      if (size.bytes <= 0) continue;
      candidates.push({ path: cache, label: cache, size: size.bytes, bucket: "caches" });
    }

    candidates.sort((a, b) => b.size - a.size);
    const items: TaskScanItem[] = candidates.map((row) => ({
      path: row.path,
      name: row.label,
      size: row.size,
      bucket: row.bucket,
    }));
    const buckets: TaskBucket[] = (
      [
        { key: "caches", label: t.cleanCaches, hint: t.cleanCachesHint, target: "", targetLabel: "", color: "accent" },
        { key: "installers", label: t.cleanInstallers, hint: t.cleanInstallersHint, target: "", targetLabel: "", color: "accent-2" },
        { key: "dupShots", label: t.cleanDupShots, hint: t.cleanDupShotsHint, target: "", targetLabel: "", color: "violet" },
        { key: "logs", label: t.cleanLogs, hint: t.cleanLogsHint, target: "", targetLabel: "", color: "warning" },
      ] satisfies TaskBucket[]
    ).filter((bucket) => items.some((item) => item.bucket === bucket.key));
    const total = items.reduce((sum, item) => sum + item.size, 0);
    return {
      items,
      buckets,
      note: items.length ? t.optRelease(formatBytes(total)) : t.optNothing,
    };
  },

  fields(_ctx, scan) {
    return [
      {
        kind: "checks" as const,
        key: "picked",
        label: text().tasks.optChecks,
        // **默认一个都不勾**：默认勾上就等于替用户决定要删东西。
        value: [],
        choices: scan.items.map((item) => ({
          value: item.path,
          label: item.name,
          hint: `${formatBytes(item.size)} · ${nameOf(item.path)}`,
        })),
      },
    ];
  },

  summary(items, plan) {
    const picked = new Set((plan.options.picked as string[] | undefined) ?? []);
    const chosen = items.filter((item) => picked.has(item.path));
    const totalBytes = chosen.reduce((sum, item) => sum + item.size, 0);
    return {
      count: chosen.length,
      totalBytes,
      etaSec: 0,
      conflictPolicy: plan.conflict,
      notes: [text().tasks.optDeleteWarning],
    };
  },

  async run(_ctx, plan, onProgress, signal) {
    const picked = new Set((plan.options.picked as string[] | undefined) ?? []);
    const items = plan.items.filter((item) => picked.has(item.path));
    const total = items.length;
    let done = 0;
    let failed = 0;
    for (const item of items) {
      if (signal.aborted) break;
      onProgress({ label: item.name, done, total, bytes: 0, totalBytes: 0 });
      try {
        // 永久删除（不进回收站）：这些东西的共同点就是「在回收站里留着也没用」，
        // 而掌机的存储本来就紧张；摘要页已经把这件事说清楚了。
        await invoke("file_delete", { path: item.path, permanent: true });
        done += 1;
      } catch {
        failed += 1;
      }
    }
    return { done, skipped: 0, failed, message: text().tasks.doneTitle(done) };
  },
};
