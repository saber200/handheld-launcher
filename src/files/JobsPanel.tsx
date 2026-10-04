/*
 * 后台任务中心（改造包 §4，画板 F3）。
 *
 * 解决的痛点只有一个：现在进度条画在文件页里（`k7-progress`），切走页面就看不见了 ——
 * 而掌机上一次搬 30 GB 是常事，用户会以为卡死了。所以这一页最关键的两件事是：
 *   1. 状态在模块里（`useFileJobs`），切页不丢、回来接着显示；
 *   2. 侧栏「文件」入口上的进度环（App.tsx），不进来也知道还在跑。
 *
 * 暂停按钮**置灰**并写明原因：暂停要在后端的传输循环里加一个 `AtomicBool`，
 * 本版没动 Rust。改造包允许这个降级，但要求「不能出现点了没反应」。
 */
import { invoke } from "@tauri-apps/api/core";
import { text } from "../i18n";
import { clearJobHistory, useFileJobs, useJobHistory, type Job } from "./useFileJobs";
import { formatBytes, formatEta } from "./tasks/env";

function percentOf(job: Job): number {
  if (job.totalBytes > 0) return Math.min(100, Math.round((job.bytes / job.totalBytes) * 100));
  if (job.itemTotal > 0) return Math.min(100, Math.round((job.itemsDone / job.itemTotal) * 100));
  return 0;
}

function rateText(job: Job): string {
  return job.rate > 0 ? `${formatBytes(job.rate)}/s` : "";
}

function etaText(job: Job): string {
  const t = text().tasks;
  return job.eta > 0 ? formatEta(job.eta, { sec: t.etaSec, min: t.etaMin, hour: t.etaHour }) : "";
}

/** 终止态的成对文案。 */
function stateText(job: Job): string {
  const t = text().tasks;
  if (job.phase === "cancelled") return t.jobsCancelled;
  if (job.phase === "error") return t.jobsFailed;
  return t.jobsSkipped(job.skipped);
}

export function JobsPanel({ onCancel }: { onCancel: (id: string) => void }) {
  const t = text().tasks;
  const running = useFileJobs().filter((job) => job.phase === "scan" || job.phase === "run");
  const history = useJobHistory();
  const finished = history.filter(
    (job) => !running.some((live) => live.id === job.id),
  );

  return (
    <section className="ft-jobs" aria-label={t.jobsTitle}>
      <header className="ft-section-head">
        <div>
          <h2>{t.jobsTitle}</h2>
          <p className="ft-section-sub">{t.jobsBody(running.length, finished.length)}</p>
        </div>
        <button
          type="button"
          className="ft-btn"
          data-focusable
          disabled={finished.length === 0}
          onClick={clearJobHistory}
        >
          {t.jobsClear}
        </button>
      </header>

      {running.length === 0 && finished.length === 0 ? (
        <div className="ft-empty">
          <p className="ft-empty-title">{t.jobsEmpty}</p>
          <p className="ft-empty-body">{t.jobsEmptyBody}</p>
        </div>
      ) : (
        <div className="ft-jobs-list">
          {running.length > 0 && <p className="ft-group-title">{t.jobsRunning}</p>}
          {running.map((job) => {
            const scanning = job.phase === "scan";
            const percent = scanning ? 0 : percentOf(job);
            return (
              <article key={job.id} className="ft-job-card">
                <span className="ft-job-icon" aria-hidden>
                  ⇄
                </span>
                <div className="ft-job-main">
                  <h3 className="ft-job-name">{job.name || text().files.folder}</h3>
                  <div className="ft-job-track" aria-hidden>
                    <span className="ft-job-fill" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="ft-job-meta tnum">
                    {scanning
                      ? text().files.transferScan
                      : t.jobsPercent(percent, formatBytes(job.bytes), formatBytes(job.totalBytes), rateText(job), etaText(job))}
                  </p>
                </div>
                <div className="ft-job-actions">
                  <button
                    type="button"
                    className="ft-btn"
                    data-focusable
                    disabled
                    title={t.jobsPauseHint}
                  >
                    {t.jobsPause}
                  </button>
                  <button
                    type="button"
                    className="ft-btn is-danger"
                    data-focusable
                    onClick={() => onCancel(job.id)}
                  >
                    {t.jobsCancel}
                  </button>
                </div>
              </article>
            );
          })}

          {finished.length > 0 && <p className="ft-group-title">{t.jobsRecent}</p>}
          {finished.map((job) => {
            const percent = percentOf(job);
            const cancelled = job.phase === "cancelled";
            return (
              <article key={`${job.id}-${job.endedAt}`} className="ft-job-row">
                <span className={cancelled ? "ft-job-mark is-muted" : "ft-job-mark"} aria-hidden>
                  {job.phase === "done" ? "✓" : cancelled ? "✕" : "!"}
                </span>
                <span className="ft-job-row-name">{job.name || text().files.folder}</span>
                <span className="ft-job-row-meta tnum">
                  {formatBytes(job.bytes)} / {formatBytes(job.totalBytes)}
                </span>
                <span className="ft-job-row-state">{stateText(job)}</span>
                {cancelled && (
                  <span className="ft-job-row-track" aria-hidden>
                    <span className="ft-job-row-fill" style={{ width: `${percent}%` }} />
                  </span>
                )}
              </article>
            );
          })}
        </div>
      )}

      <div className="ft-note">
        <span className="ft-note-mark" aria-hidden>
          ⓘ
        </span>
        <div>
          <p className="ft-note-title">{t.jobsNote}</p>
          <p className="ft-note-body">{t.jobsNoteBody}</p>
        </div>
      </div>
    </section>
  );
}

/** 取消一个后台活儿（后端 `file_cancel`）。 */
export function cancelJob(id: string): void {
  void invoke("file_cancel", { id }).catch(() => undefined);
}
