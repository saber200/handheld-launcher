/*
 * 任务入口层（改造包 §2，画板 F1 上半）。
 *
 * 8 张卡：4 列 × 2 行（画板尺寸 (996 − 16×3) / 4 = 237 × 108）。
 * 卡片置灰要有原因 —— 「按了没反应的灰按钮」比不显示更让人困惑。
 */
import { text } from "../i18n";
import { TASKS } from "./tasks";
import type { TaskDef, TaskRuntime } from "./tasks/types";

export function TaskGrid({
  runtime,
  onOpen,
}: {
  /** 外部盘列表（U 盘卡置灰要用）；还没读出来时传 null，卡片先按可用渲染。 */
  runtime: TaskRuntime | null;
  onOpen: (task: TaskDef) => void;
}) {
  const t = text().tasks;
  return (
    <section className="ft-grid" aria-label={t.tabTasks}>
      <header className="ft-section-head">
        <div>
          <h2>{t.tabTasks}</h2>
          <p className="ft-section-sub">{t.gridBody}</p>
        </div>
      </header>
      <div className="ft-grid-cards">
        {TASKS.map((task) => {
          const card = task.card();
          const reason = runtime ? task.unavailable(runtime) : null;
          return (
            <button
              key={task.id}
              type="button"
              className={`ft-card is-${task.accent}${reason ? " is-off" : ""}`}
              data-focusable
              disabled={Boolean(reason)}
              aria-label={reason ? t.cardUnavailable(reason) : t.cardOpen(card.title)}
              onClick={() => onOpen(task)}
            >
              <span className="ft-card-title">{card.title}</span>
              <span className="ft-card-desc">{card.desc}</span>
              <span className="ft-card-meta">{reason ? t.cardUnavailable(reason) : card.meta}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
