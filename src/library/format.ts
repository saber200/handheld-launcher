import { text } from "../i18n";

/**
 * 库卡片上那两个数字的写法（画板 K1/K2 都是这个口味）：
 *   体积 「8.4 GB」（GB 一位小数）/「240 MB」（MB 取整）/「512 KB」
 *   时长 「42.6 小时」（不足一小时写分钟）
 *
 * **0 / undefined 一律返回空串** —— 这两项在 Rust 那边就是「0 = 不知道」（老缓存里没有、
 * Epic 没有时长、注册表没写 EstimatedSize）。空串让调用方直接跳过那一格/那一行，
 * 而不是显示「0 MB」「0 分钟」这种看着像真数的假数据。
 */
export function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatPlaytime(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return "";
  if (minutes >= 60) return text().library.hours((minutes / 60).toFixed(1));
  return text().library.minutes(String(Math.round(minutes)));
}

/** 聚焦卡第二行的「时长 · 体积」；两个都没有就是空串（那一行整个不画）。 */
export function formatPlaytimeAndSize(playtimeMinutes: number | undefined, sizeBytes: number | undefined): string {
  return [formatPlaytime(playtimeMinutes), formatSize(sizeBytes)].filter(Boolean).join(" · ");
}
