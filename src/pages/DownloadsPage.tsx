/*
 * 下载（画板 K6）。
 *
 * 画板上那些行是 **Steam 的下载**（「更新补丁 4 · 75.6 / 122.4 GB」）—— 启动器看不到 Steam
 * 的队列，那是 Steam 自己管的。所以这一页只说启动器自己在做的事，而且都是真进度：
 *   - 文件传输（复制 / 移动 / 导入 ROM / U 盘）：`useFileJobs`，带暂停、取消、速度、剩余时间；
 *   - Mod / 工具安装（OptiScaler）：`useModProgress` 的事件。
 *
 * 队列 / 优先级 / 限速需要后端有队列模型（OptiScaler 目前一次只装一个、`toolbox_cancel_mod`
 * 只能取消），所以那三样**不画**（画了就是假按钮）。底部那条说清楚 Steam 的事。
 */
import { text } from "../i18n";
import { cancelJob, JobsPanel } from "../files/JobsPanel";
import { useFileJobs, useJobHistory } from "../files/useFileJobs";
import { formatBytes, formatEta } from "../files/tasks/env";
import { useModProgress } from "../library/useModProgress";

export function DownloadsPage({ onOpenFiles }: { onOpenFiles: () => void }) {
  const m = text().downloads;
  const t = text().tasks;
  const running = useFileJobs().filter((job) => job.phase === "scan" || job.phase === "run");
  const history = useJobHistory();
  const finished = history.filter((job) => !running.some((live) => live.id === job.id));
  const mod = useModProgress();

  // 数字都是这一页自己算的：总速率与剩余时间只看**真的在跑**的那几条。
  const rate = running.reduce((sum, job) => sum + job.rate, 0);
  const eta = running.reduce((max, job) => Math.max(max, job.eta), 0);
  const bytes = running.reduce((sum, job) => sum + job.bytes, 0) + (mod?.bytes ?? 0);
  const totalBytes = running.reduce((sum, job) => sum + job.totalBytes, 0) + (mod?.totalBytes ?? 0);
  const modPercent = mod && mod.totalBytes > 0 ? Math.round((mod.bytes / mod.totalBytes) * 100) : 0;
  const modRunning = Boolean(mod && mod.phase !== "done");

  return (
    <main className="page k6-page">
      <div className="k6-head">
        <h2>{m.title}</h2>
        <p className="k6-sub">{m.sub(running.length + (modRunning ? 1 : 0), finished.length)}</p>
        {/* 画板那两颗是「全部暂停 / 限速」：要后端有队列与限速实现，这一版不做。 */}
      </div>

      <section className="k6-stats" aria-label={m.title}>
        <div className="k6-stat">
          <span className="k6-stat-label">{m.statRate}</span>
          <strong className="k6-stat-value tnum">{rate > 0 ? `${formatBytes(rate)}/s` : "—"}</strong>
        </div>
        <div className="k6-stat">
          <span className="k6-stat-label">{m.statEta}</span>
          <strong className="k6-stat-value tnum">
            {eta > 0 ? formatEta(eta, { sec: t.etaSec, min: t.etaMin, hour: t.etaHour }) : "—"}
          </strong>
        </div>
        <div className="k6-stat">
          <span className="k6-stat-label">{m.statBytes}</span>
          <strong className="k6-stat-value tnum">
            {formatBytes(bytes)} / {formatBytes(totalBytes)}
          </strong>
        </div>
      </section>

      {modRunning ? (
        <section className="k6-mod" aria-label={m.modSection}>
          <h3>{m.modSection}</h3>
          <p className="k6-mod-row tnum">
            {m.modRow(String(modPercent), `${formatBytes(mod?.bytes ?? 0)} / ${formatBytes(mod?.totalBytes ?? 0)}`)}
          </p>
          <div className="k6-track" aria-hidden>
            <span className="k6-fill" style={{ width: `${modPercent}%` }} />
          </div>
        </section>
      ) : null}

      {/* 文件传输那一半直接复用任务中心的面板：同一份数据、同一套按钮，不再抄一遍。 */}
      <JobsPanel onCancel={cancelJob} onOpenFiles={onOpenFiles} />

      <div className="k6-note">
        <strong>{m.note}</strong>
        <span>{m.noteBody}</span>
      </div>
    </main>
  );
}
