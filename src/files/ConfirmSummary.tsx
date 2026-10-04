/*
 * 确认前置总量摘要（改造包 §5.3，增强 8）。
 *
 * 「12 个文件 / 8.4 GB / 约 40 秒 / 跳过同名」这四个数要在动手**之前**摆出来。
 * 两处用它：向导第 3 步（内联）、文件页里的大批量操作（弹层）。
 *
 * 耗时是**估算**，所以卡片底部的说明里必须写清按什么估的（45 MB/s）——
 * 掌机的卡有快有慢，报一个不带前提的「约 40 秒」等于骗人。
 */
import { text } from "../i18n";
import { formatBytes } from "./tasks/env";
import type { ConflictPolicy, TaskSummary } from "./tasks/types";

export function conflictLabel(policy: ConflictPolicy): string {
  const t = text().tasks;
  if (policy === "skip") return t.conflictSkip;
  if (policy === "replace") return t.conflictReplace;
  return t.conflictKeep;
}

export function etaLabel(seconds: number): string {
  const t = text().tasks;
  if (seconds <= 0) return "—";
  if (seconds < 90) return t.etaSec.replace("{n}", String(Math.max(1, Math.round(seconds))));
  if (seconds < 5400) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return t.etaMin.replace("{m}", String(minutes)).replace("{s}", String(rest));
  }
  return t.etaHour.replace("{n}", (seconds / 3600).toFixed(1));
}

export function ConfirmSummary({
  summary,
  /** false = 这次操作跟同名策略无关（删除、备份），那一格显示「不需要」。 */
  showConflict = true,
  children,
}: {
  summary: TaskSummary;
  showConflict?: boolean;
  children?: React.ReactNode;
}) {
  const t = text().tasks;
  return (
    <section className="ft-summary" aria-label={t.summaryTitle}>
      <h2 className="ft-summary-title">{t.summaryTitle}</h2>
      <div className="ft-summary-grid">
        <div className="ft-summary-cell">
          <span className="ft-summary-label">{t.sumCount}</span>
          <strong className="ft-summary-value tnum">{summary.count}</strong>
        </div>
        <div className="ft-summary-cell">
          <span className="ft-summary-label">{t.sumBytes}</span>
          <strong className="ft-summary-value tnum">{formatBytes(summary.totalBytes)}</strong>
        </div>
        <div className="ft-summary-cell">
          <span className="ft-summary-label">{t.sumEta}</span>
          <strong className="ft-summary-value tnum">
            {summary.etaSec > 0 ? etaLabel(summary.etaSec) : "—"}
          </strong>
        </div>
        <div className="ft-summary-cell">
          <span className="ft-summary-label">{t.sumConflict}</span>
          <strong className="ft-summary-value">
            {showConflict ? conflictLabel(summary.conflictPolicy) : t.sumNone}
          </strong>
        </div>
      </div>
      <ul className="ft-summary-notes">
        {summary.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      {children}
    </section>
  );
}
