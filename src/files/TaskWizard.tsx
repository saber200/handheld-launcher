/*
 * 四步向导（改造包 §2.3，画板 F1）。
 *
 * 这个组件**不认识任何具体任务**：它只做「步骤流转 + 把 TaskDef 回报的东西画出来」。
 * 所以加第 9 个任务时这里一行都不用改 —— 这正是接口设计的目的（见 `tasks/types.ts`）。
 *
 * 四步：① 选来源 ② 看识别结果、改目标与同名策略 ③ 确认总量（增强 8）④ 执行。
 * 任务不需要来源时（备份存档、清理空间）第 ① 步自动跳过。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { text } from "../i18n";
import { ConfirmSummary, conflictLabel } from "./ConfirmSummary";
import { FolderPicker } from "./FolderPicker";
import { formatBytes } from "./tasks/env";
import type {
  ConflictPolicy,
  TaskCtx,
  TaskDef,
  TaskField,
  TaskPlan,
  TaskProgress,
  TaskResult,
  TaskScan,
  TaskSource,
  TaskSummary,
} from "./tasks/types";

type Step = 0 | 1 | 2 | 3;

export function TaskWizard({
  task,
  ctx,
  backRef,
  onClose,
  onFinished,
}: {
  task: TaskDef;
  ctx: TaskCtx;
  /** 父组件（文件页）把 B 键交给向导：指向这里最新的 `back`。 */
  backRef: React.RefObject<() => boolean>;
  onClose: () => void;
  onFinished: () => void;
}) {
  const t = text().tasks;
  const card = task.card();

  const [step, setStep] = useState<Step>(0);
  const [source, setSource] = useState<TaskSource | null>(null);
  const [picked, setPicked] = useState("");
  const [scan, setScan] = useState<TaskScan | null>(null);
  const [fields, setFields] = useState<TaskField[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<ConflictPolicy>("skip");
  const [options, setOptions] = useState<Record<string, unknown>>({});
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [picker, setPicker] = useState<{ key: string; label: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const plan: TaskPlan = useMemo(
    () => ({
      items: scan?.items ?? [],
      buckets: scan?.buckets ?? [],
      targets,
      conflict,
      options,
    }),
    [scan, targets, conflict, options],
  );

  /** 扫来源 + 备好第 2 步的默认值（目标目录、任务的选项）。 */
  const beginScan = useCallback(
    async (from: string) => {
      setBusy(true);
      setNote("");
      try {
        const found = await task.scan(ctx, from);
        const nextTargets: Record<string, string> = {};
        for (const bucket of found.buckets) nextTargets[bucket.key] = bucket.target;
        const nextOptions: Record<string, unknown> = {};
        const rows = await task.fields(ctx, found, {
          items: found.items,
          buckets: found.buckets,
          targets: nextTargets,
          conflict: "skip",
          options: nextOptions,
        });
        for (const field of rows) {
          if (field.kind === "chips") nextOptions[field.key] = field.value;
          if (field.kind === "checks") nextOptions[field.key] = field.value;
        }
        setScan(found);
        setTargets(nextTargets);
        setOptions(nextOptions);
        setFields(rows);
        setStep(1);
      } catch (err) {
        setNote((err as { message?: string } | null)?.message ?? String(err));
      } finally {
        setBusy(false);
      }
    },
    [ctx, task],
  );

  // 第 ① 步：问任务要来源。不需要来源（备份存档 / 清理空间）就直接开扫。
  useEffect(() => {
    let alive = true;
    void (async () => {
      setBusy(true);
      try {
        const info = await task.source(ctx);
        if (!alive) return;
        setSource(info);
        if (!info || info.options.length === 0) {
          setBusy(false);
          await beginScan(info?.value ?? "");
          return;
        }
        setPicked(info.value);
      } catch (err) {
        if (alive) setNote((err as { message?: string } | null)?.message ?? String(err));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
      abort.current?.abort();
    };
    // 只在换任务时重来：`ctx` / `beginScan` 每次渲染都是新引用，放进依赖会死循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  const goSummary = useCallback(async () => {
    if (!scan) return;
    setBusy(true);
    try {
      const next = await task.summary(scan.items, plan);
      setSummary(next);
      setStep(2);
    } catch (err) {
      setNote((err as { message?: string } | null)?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [plan, scan, task]);

  const start = useCallback(async () => {
    setStep(3);
    setResult(null);
    setProgress({ label: "", done: 0, total: scan?.items.length ?? 0, bytes: 0, totalBytes: 0 });
    const controller = new AbortController();
    abort.current = controller;
    try {
      const done = await task.run(ctx, plan, (next) => setProgress({ ...next }), controller.signal);
      setResult(done);
    } catch (err) {
      setResult({
        done: 0,
        skipped: 0,
        failed: 1,
        message: (err as { message?: string } | null)?.message ?? String(err),
      });
    } finally {
      abort.current = null;
    }
  }, [ctx, plan, scan, task]);

  /** B 键 / 「上一步」：按当前步骤决定去哪儿。返回 true 表示这次按键被接走了。 */
  const back = useCallback((): boolean => {
    if (picker) {
      setPicker(null);
      return true;
    }
    if (step === 3) {
      // 正在跑就先取消（取消会回滚），跑完了才退出。
      if (abort.current) {
        abort.current.abort();
        return true;
      }
      onFinished();
      onClose();
      return true;
    }
    if (step === 2) {
      setStep(1);
      return true;
    }
    if (step === 1) {
      if (source && source.options.length > 0) {
        setStep(0);
        return true;
      }
      onClose();
      return true;
    }
    onClose();
    return true;
  }, [onClose, onFinished, picker, source, step]);

  // 每渲染一次都刷新：父组件的 ref 永远指向最新那个 `back`（它读的是最新的 step）。
  backRef.current = back;

  const percent = progress
    ? progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100))
      : progress.total > 0
        ? Math.min(100, Math.round((progress.done / progress.total) * 100))
        : 0
    : 0;

  return (
    <section className="ft-wizard" aria-label={card.title}>
      <header className="ft-wizard-head">
        <div>
          <h2>{card.title}</h2>
          <p className="ft-section-sub">{picked || source?.value || t.sourceBody}</p>
        </div>
        <button type="button" className="ft-btn" data-focusable onClick={onClose}>
          {t.close}
        </button>
      </header>

      <ol className="ft-steps">
        {t.stepNames.map((name, index) => (
          <li
            key={name}
            className={`ft-step${index === step ? " is-current" : ""}${index < step ? " is-done" : ""}`}
          >
            <span className="ft-step-dot" aria-hidden>
              {index < step ? "✓" : index + 1}
            </span>
            {name}
          </li>
        ))}
      </ol>

      {busy && !scan && <p className="ft-note-body">{t.scanning}</p>}
      {note && <p className="ft-error">{note}</p>}

      <div className="ft-wizard-body">
        {step === 0 && source && source.options.length > 0 && (
          <div className="ft-source-list" data-focus-zone="ft-source">
            <p className="ft-group-title">{t.sourceBody}</p>
            {source.options.map((row) => (
              <button
                key={row.value}
                type="button"
                className={row.value === picked ? "ft-source is-current" : "ft-source"}
                data-focusable
                aria-pressed={row.value === picked}
                onClick={() => setPicked(row.value)}
              >
                <span className="ft-source-label">{row.label}</span>
                <span className="ft-source-path">{row.value}</span>
              </button>
            ))}
          </div>
        )}

        {step === 0 && (!source || source.options.length === 0) && !busy && (
          <p className="ft-note-body">{t.sourceMissing}</p>
        )}

        {(step === 1 || step === 2) && scan && (
          <>
            <div className="ft-result">
              <div className="ft-card-head">
                <h3>{t.resultTitle}</h3>
                <span className="tnum">{scan.note}</span>
              </div>
              {scan.buckets.length === 0 ? (
                <p className="ft-note-body">{t.resultEmpty}</p>
              ) : (
                <ul className="ft-buckets">
                  {scan.buckets.map((bucket) => {
                    const rows = scan.items.filter((item) => item.bucket === bucket.key);
                    const bytes = rows.reduce((sum, row) => sum + row.size, 0);
                    return (
                      <li key={bucket.key} className={`ft-bucket is-${bucket.color}`}>
                        <span className="ft-bucket-dot" aria-hidden />
                        <span className="ft-bucket-name">{bucket.label}</span>
                        <span className="ft-bucket-emu">
                          {bucket.emulator ? `→ ${bucket.emulator}` : (bucket.hint ?? "")}
                        </span>
                        <span className="ft-bucket-count tnum">{rows.length}</span>
                        <span className="ft-bucket-size tnum">{formatBytes(bytes)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {step === 1 && (
              <div className="ft-fields">
                {fields.map((field) => (
                  <FieldBlock
                    key={field.key}
                    field={field}
                    onTarget={(key, value) => setTargets((prev) => ({ ...prev, [key]: value }))}
                    onValue={(key, value) => setOptions((prev) => ({ ...prev, [key]: value }))}
                    onOpenPicker={(key, label) => setPicker({ key, label })}
                  />
                ))}

                {task.usesConflict && (
                  <div className="ft-field">
                    <p className="ft-field-label">{t.conflictTitle}</p>
                    <div className="ft-chips">
                      {(["skip", "replace", "keepBoth"] as ConflictPolicy[]).map((policy) => (
                        <button
                          key={policy}
                          type="button"
                          className={policy === conflict ? "ft-chip is-on" : "ft-chip"}
                          data-focusable
                          aria-pressed={policy === conflict}
                          onClick={() => setConflict(policy)}
                        >
                          {conflictLabel(policy)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {step === 2 && summary && (
              <div className="ft-summary-wrap">
                <ConfirmSummary summary={summary} showConflict={task.usesConflict} />
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <div className="ft-run">
            <h3>{result ? result.message || t.doneTitle(result.done) : t.runTitle}</h3>
            {!result && (
              <>
                <div className="ft-job-track" aria-hidden>
                  <span className="ft-job-fill" style={{ width: `${percent}%` }} />
                </div>
                <p className="ft-job-meta tnum">
                  {progress?.label ? `${progress.label} · ` : ""}
                  {t.runProgress(progress?.done ?? 0, progress?.total ?? 0)}
                </p>
                <p className="ft-note-body">{t.runBody}</p>
              </>
            )}
            {result && (
              <ul className="ft-summary-notes">
                {result.skipped > 0 && <li>{t.doneSkipped(result.skipped)}</li>}
                {result.failed > 0 && <li>{t.doneFailed(result.failed)}</li>}
                {result.rolledBack &&
                  (result.rolledBack.moved === 0 && result.rolledBack.failed === 0 ? (
                    <li>{t.rollbackNone}</li>
                  ) : (
                    <li>{t.rollbackOk(result.rolledBack.moved)}</li>
                  ))}
                {result.rolledBack && result.rolledBack.failed > 0 && (
                  <li className="is-warning">{t.rollbackFail(result.rolledBack.failed)}</li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="ft-wizard-bar">
        <button type="button" className="ft-btn" data-focusable onClick={() => back()}>
          {step === 0 ? t.close : t.back}
        </button>
        {step === 0 && (
          <button
            type="button"
            className="ft-btn is-primary"
            data-focusable
            disabled={!picked || busy}
            onClick={() => void beginScan(picked)}
          >
            {t.next}
          </button>
        )}
        {step === 1 && (
          <button
            type="button"
            className="ft-btn is-primary"
            data-focusable
            disabled={busy || (scan?.items.length ?? 0) === 0}
            onClick={() => void goSummary()}
          >
            {t.next}
          </button>
        )}
        {step === 2 && (
          <button type="button" className="ft-btn is-primary" data-focusable onClick={() => void start()}>
            {t.start}
          </button>
        )}
        {step === 3 && !result && (
          <button
            type="button"
            className="ft-btn is-danger"
            data-focusable
            onClick={() => abort.current?.abort()}
          >
            {abort.current ? t.runCancel : t.runCancelling}
          </button>
        )}
        {step === 3 && result && (
          <>
            <button
              type="button"
              className="ft-btn"
              data-focusable
              onClick={() => {
                setResult(null);
                setProgress(null);
                setScan(null);
                setStep(0);
              }}
            >
              {t.again}
            </button>
            <button
              type="button"
              className="ft-btn is-primary"
              data-focusable
              onClick={() => {
                onFinished();
                onClose();
              }}
            >
              {t.close}
            </button>
          </>
        )}
      </div>

      {picker && (
        <FolderPicker
          title={picker.label}
          start={targets[picker.key] ?? ""}
          onClose={() => setPicker(null)}
          onPick={(value) => {
            setTargets((prev) => ({ ...prev, [picker.key]: value }));
            setPicker(null);
          }}
        />
      )}
    </section>
  );
}

/** 第 2 步的一格：目标位置 / 选择项 / 勾选项。 */
function FieldBlock({
  field,
  onTarget,
  onValue,
  onOpenPicker,
}: {
  field: TaskField;
  onTarget: (key: string, value: string) => void;
  onValue: (key: string, value: unknown) => void;
  onOpenPicker: (key: string, label: string) => void;
}) {
  const t = text().tasks;
  if (field.kind === "target") {
    const bucket = field.key.startsWith("target:") ? field.key.slice("target:".length) : field.key;
    return (
      <div className="ft-field">
        <p className="ft-field-label">{field.label}</p>
        <button
          type="button"
          className={field.value ? "ft-value" : "ft-value is-empty"}
          data-focusable
          onClick={() => onOpenPicker(bucket, field.label)}
        >
          <span className="ft-value-text">{field.value || t.targetMissing}</span>
          <span className="ft-value-action">{t.targetPick}</span>
        </button>
        {field.hint && <p className="ft-field-hint">{field.hint}</p>}
      </div>
    );
  }
  if (field.kind === "chips") {
    return (
      <div className="ft-field">
        <p className="ft-field-label">{field.label}</p>
        <div className="ft-chips">
          {field.chips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={chip.value === field.value ? "ft-chip is-on" : "ft-chip"}
              data-focusable
              aria-pressed={chip.value === field.value}
              title={chip.hint}
              onClick={() => {
                // 给了 `target` 的 chips 是「选一个目标目录」（装 Mod 选游戏）；
                // 其余的是任务自己的选项（截图的三种动作）。
                if (field.target) onTarget(field.target, chip.value);
                onValue(field.key, chip.value);
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
        {field.hint && <p className="ft-field-hint">{field.hint}</p>}
      </div>
    );
  }
  // checks：清理空间的候选、要备份的存档、要处理的截图。
  // **默认给什么就选什么**；清理空间那边给的是空数组（默认一个都不勾）。
  const current = Array.isArray(field.value) ? field.value : [];
  return (
    <div className="ft-field">
      <p className="ft-field-label">{field.label}</p>
      <ul className="ft-checks">
        {field.choices.map((choice) => {
          const on = current.includes(choice.value);
          return (
            <li key={choice.value}>
              <button
                type="button"
                className={on ? "ft-check on" : "ft-check"}
                data-focusable
                aria-pressed={on}
                onClick={() =>
                  onValue(
                    field.key,
                    on ? current.filter((row) => row !== choice.value) : [...current, choice.value],
                  )
                }
              >
                <span className="ft-check-box" aria-hidden>
                  {on ? "✓" : ""}
                </span>
                <span className="ft-check-label">{choice.label}</span>
                {choice.hint && <span className="ft-check-hint tnum">{choice.hint}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {field.hint && <p className="ft-field-hint">{field.hint}</p>}
    </div>
  );
}
