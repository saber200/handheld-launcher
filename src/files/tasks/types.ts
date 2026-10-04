/*
 * 任务层的接口定义（改造包 §2.2）。
 *
 * 为什么先单独一个文件：`TaskWizard` 只做 UI 与步骤流转，所有业务判断都在各自的
 * `tasks/*.ts` 里；加第 9 个任务 = 加一个文件 + 在 `index.ts` 注册一行，向导一行都不用改。
 * 把接口钉死在这里，新增任务时编译器会告诉你少了哪一步。
 */
import type { FileEntry } from "../useFileBrowser";

export type TaskId =
  | "importRom"
  | "installMod"
  | "backupSaves"
  | "restoreSaves"
  | "exportShots"
  | "cleanup"
  | "usb"
  | "recentJobs";

/** 同名文件的处理策略。`keepBoth` = 保留两者（自动加后缀）。 */
export type ConflictPolicy = "skip" | "replace" | "keepBoth";

export type TaskAccent = "accent" | "accent-2" | "violet" | "warning";

/** 扫出来的一个条目。`bucket` 是任务自己判定出来的分类键。 */
export interface TaskScanItem {
  path: string;
  name: string;
  size: number;
  bucket: string;
  meta?: Record<string, string | number>;
}

/** 一个分组 = 向导里的一行「分类 → 目标目录」。 */
export interface TaskBucket {
  key: string;
  label: string;
  /** 建议目标目录（用户可以在第 2 步改）。 */
  target: string;
  targetLabel: string;
  hint?: string;
  emulator?: string;
  color: TaskAccent;
  /** true = 任务认不出这一类，目标留空、必须由用户指定。 */
  manual?: boolean;
}

export interface TaskScan {
  items: TaskScanItem[];
  buckets: TaskBucket[];
  /** 扫完给用户的一句话（如「24 个文件 · 186 MB · 最早 3 天前」）。 */
  note?: string;
  /** 有些任务在第 1 步就把内容扫完了（清理空间），这时第 2 步不再重扫。 */
  ready?: boolean;
}

export type TaskPlan = {
  items: TaskScanItem[];
  buckets: TaskBucket[];
  /** bucket.key → 目标目录（用户改过就是改后的）。 */
  targets: Record<string, string>;
  conflict: ConflictPolicy;
  /** 任务自己的选择：清理项的勾选、截图要做什么、U 盘要弹出还是导入…… */
  options: Record<string, unknown>;
};

/** 第 2 步里用户能改的字段。 */
export type TaskField =
  | { kind: "target"; key: string; label: string; value: string; hint?: string }
  | {
      kind: "chips";
      key: string;
      label: string;
      value: string;
      hint?: string;
      chips: { value: string; label: string; hint?: string }[];
      /** 给了就把选择直接写进 `plan.targets[target]`（装 Mod 选游戏就是这种）。 */
      target?: string;
    }
  | {
      kind: "checks";
      key: string;
      label: string;
      value: string[];
      hint?: string;
      choices: { value: string; label: string; hint?: string }[];
    };

export interface TaskSummary {
  count: number;
  totalBytes: number;
  /** 预计耗时（秒）。0 = 算不出来（总量未知）。 */
  etaSec: number;
  conflictPolicy: ConflictPolicy;
  /** 摘要下面的补充说明（「覆盖前会自动备份为 .bak」这类）。 */
  notes: string[];
}

/** 执行中回报给向导的一次进度。 */
export interface TaskProgress {
  /** 当前在做什么（当前文件名 / 当前阶段）。 */
  label: string;
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
}

export interface TaskResult {
  done: number;
  skipped: number;
  failed: number;
  /** 收尾那句话（可以直接显示给用户）。 */
  message: string;
  /** 取消后回滚的结果，没取消就是 undefined。 */
  rolledBack?: { moved: number; failed: number };
}

/** 第 1 步让用户挑的来源。 */
export interface TaskSource {
  label: string;
  value: string;
  options: { value: string; label: string; hint?: string }[];
  hint?: string;
}

/**
 * 任务拿得到的东西。做成显式对象而不是让任务直接 `invoke`：
 * 一是测试与浏览器预览里能给假的实现，二是任务代码里就不会散落路径常量。
 */
export interface TaskCtx {
  /** 已知目录（`%USERPROFILE%\Downloads`、模拟器 ROM 根、备份根、截图目录……）。 */
  dirs: TaskDirs;
  /** 列目录（复用现有 `file_list`）。 */
  list(path: string): Promise<FileEntry[]>;
  /** 量一个路径的大小（复用现有 `file_properties`）。 */
  measure(path: string): Promise<{ bytes: number; complete: boolean }>;
  /** 盘符 / U 盘（复用现有 `file_places`）。 */
  drives(): Promise<FileEntry[]>;
  /** 用既有命令建目录（`file_make_dir`，父目录逐级建）。 */
  makeDir(path: string): Promise<void>;
  /** 已安装的游戏（复用现有 `scan_games`）：装 Mod、备份存档都要它。 */
  games(): Promise<{ name: string; installPath: string }[]>;
}

export interface TaskDirs {
  home: string;
  downloads: string;
  pictures: string;
  desktop: string;
  documents: string;
  /** `%APPDATA%`（Windows）。存档大多在这儿。 */
  roaming: string;
  /** `%LOCALAPPDATA%`。 */
  localAppData: string;
  /** `文档\My Games`：一部分老游戏的存档落点。 */
  myGames: string;
  /** 模拟器 ROM 根。取不到就没有（向导会要求用户手动指定）。 */
  roms: string;
  /** 存档备份根。 */
  backups: string;
  /** 截图目录（`图片\截图`）。 */
  shots: string;
}

/**
 * 卡片置灰要用到的东西。`unavailable` 是同步的（卡片渲染时就要知道灰不灰），
 * 所以异步读来的结果由外层先备好。
 */
export interface TaskRuntime {
  /** 非系统盘（U 盘 / SD 卡候选）。 */
  external: FileEntry[];
}

export interface TaskDef {
  id: TaskId;
  accent: TaskAccent;
  /** 卡片上的三段文字（中英各一份，从 `text().tasks.cards.<id>` 取）。 */
  card(): { title: string; desc: string; meta: string };
  /** 置灰原因；null = 可用。 */
  unavailable(runtime: TaskRuntime): string | null;
  /**
   * 第 1 步：让用户挑来源。返回 null = 这个任务不需要来源，
   * 向导跳过第 1 步（最近传输就是这种）。
   */
  source(ctx: TaskCtx): Promise<TaskSource | null>;
  /** 扫来源并分组。第 1 步选完来源就调它，结果在第 2 步显示。 */
  scan(ctx: TaskCtx, source: string): Promise<TaskScan>;
  /** 第 2 步里用户能改的字段。可以是异步的：装 Mod 要先问游戏库有哪些游戏。 */
  fields(ctx: TaskCtx, scan: TaskScan, plan: TaskPlan): TaskField[] | Promise<TaskField[]>;
  /** 第 3 步：总量摘要（增强 8）。 */
  summary(items: TaskScanItem[], plan: TaskPlan): TaskSummary;
  /** 第 4 步：执行。必须支持进度与取消。 */
  run(
    ctx: TaskCtx,
    plan: TaskPlan,
    onProgress: (progress: TaskProgress) => void,
    signal: AbortSignal,
  ): Promise<TaskResult>;
/** `usesConflict = false` 的任务（清理空间）不显示同名策略。 */
  usesConflict: boolean;
  /** 点这张卡直接跳到别处（「最近传输」= 任务中心），不走向导。 */
  jump?: "jobs";
}
