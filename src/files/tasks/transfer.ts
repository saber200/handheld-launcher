/*
 * 任务层的「搬文件」：一次一项地调现有 `file_transfer`，把事件翻译成任务能用的进度。
 *
 * 为什么不用一次 `file_transfer(items)` 搬完：
 *   1. **取消要能回滚**（改造包「两个必须特别注意的实现点」第一名）。一次搬完的话，
 *      后端只知道「搬了 3 项」，前端拿不到具体搬了哪三项、更不知道落到了哪个名字上。
 *   2. 同名策略是「保留两者」时后端会给文件改名（`x.nsp` → `x (2).nsp`），
 *      前端猜不出那个名字，只能搬完一项就列一遍目标目录对差集。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileEntry } from "../useFileBrowser";
import type { ConflictPolicy } from "./types";
import { joinPath } from "./env";

/** Rust 侧 `files.rs::TransferProgress`（事件名 `files-transfer`）。 */
type TransferEvent = {
  id: string;
  phase: "scan" | "run" | "done" | "cancelled" | "error";
  name: string;
  itemIndex: number;
  itemTotal: number;
  itemsDone: number;
  skipped: number;
  bytes: number;
  totalBytes: number;
  message: string;
  reason: string;
};

export type TransferItem = { path: string; name: string; size: number };

export type TransferOutcome = {
  done: number;
  skipped: number;
  cancelled: boolean;
  /** 已经搬过去的项（取消回滚按它搬回去）。 */
  moved: { from: string; to: string }[];
  failure?: { reason: string; message: string };
};

export type TransferProgress = {
  /** 当前项的名字（给用户看「正在搬哪个」）。 */
  label: string;
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
};

/** 后端认的冲突策略字符串。`keepBoth` → `keep`（见 `files.rs::Conflict::parse`）。 */
function backendConflict(policy: ConflictPolicy): string {
  if (policy === "skip") return "skip";
  if (policy === "replace") return "replace";
  return "keep";
}

/** 单项超时：SD 卡上 10 GB 的包能搬十几分钟，给足；卡死时靠它兜底。 */
const ITEM_TIMEOUT_MS = 30 * 60 * 1000;

let sequence = 0;

async function listNames(dir: string): Promise<string[]> {
  try {
    const rows = await invoke<FileEntry[]>("file_list", { path: dir });
    return rows.map((row) => row.name);
  } catch {
    return [];
  }
}

function parentDirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut <= 0 ? path : path.slice(0, cut);
}

type Terminal = { phase: TransferEvent["phase"]; message: string; reason: string };

/** 搬一项，等它到终态。 */
async function transferOne(options: {
  id: string;
  item: TransferItem;
  destDir: string;
  mode: "copy" | "move";
  conflict: ConflictPolicy;
  onTick: (event: TransferEvent) => void;
  signal: AbortSignal;
}): Promise<Terminal> {
  const { id, item, destDir, mode, conflict, onTick, signal } = options;
  let settle: ((value: Terminal) => void) | null = null;
  let timer = 0;
  const terminal = new Promise<Terminal>((resolve) => {
    settle = resolve;
    timer = window.setTimeout(
      () => resolve({ phase: "error", message: "", reason: "timeout" }),
      ITEM_TIMEOUT_MS,
    );
    // 用户按了取消（或用户退出向导）：让后端停在当前这一项上，
    // 等它自己的终态事件回来才算结束 —— 不然「已搬几项」会跟实际对不上。
    const stop = () => void invoke("file_cancel", { id }).catch(() => undefined);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  const unlisten = await listen<TransferEvent>("files-transfer", (event) => {
    if (event.payload.id !== id) return;
    onTick(event.payload);
    const phase = event.payload.phase;
    if (phase === "done" || phase === "cancelled" || phase === "error") {
      settle?.({ phase, message: event.payload.message, reason: event.payload.reason });
    }
  });
  try {
    await invoke("file_transfer", {
      id,
      items: [item.path],
      destDir,
      mode,
      conflict: backendConflict(conflict),
    });
  } catch (err) {
    window.clearTimeout(timer);
    unlisten();
    const info = err as { reason?: string; message?: string } | null;
    return {
      phase: "error",
      message: info?.message ?? String(err),
      reason: info?.reason ?? "other",
    };
  }
  const result = await terminal;
  window.clearTimeout(timer);
  unlisten();
  return result;
}

/**
 * 一项一项搬。取消时已搬完的部分**不回滚**（回滚是调用方的事：只有 move 模式才有
 * 「一半在这边一半在那边」的问题）—— 但每一项的落点都原样报回去，调用方才有得选。
 */
export async function runTransfer(options: {
  items: TransferItem[];
  destDir: string;
  mode: "copy" | "move";
  conflict: ConflictPolicy;
  onProgress: (progress: TransferProgress) => void;
  signal: AbortSignal;
}): Promise<TransferOutcome> {
  const { items, destDir, mode, conflict, onProgress, signal } = options;
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  const outcome: TransferOutcome = { done: 0, skipped: 0, cancelled: false, moved: [] };
  let bytesBefore = 0;
  // 只有 move 才需要记住落点（回滚用）；复制不用，也就省掉每项一次列目录。
  const trackLanding = mode === "move";
  for (const item of items) {
    if (signal.aborted) {
      outcome.cancelled = true;
      break;
    }
    const before = trackLanding ? await listNames(destDir) : [];
    const id = `task-${Date.now().toString(36)}-${sequence++}`;
    const result = await transferOne({
      id,
      item,
      destDir,
      mode,
      conflict,
      signal,
      onTick: (event) => {
        if (event.phase !== "run" && event.phase !== "scan") return;
        onProgress({
          label: item.name,
          done: outcome.done,
          total: items.length,
          bytes: bytesBefore + Math.min(event.bytes, item.size),
          totalBytes,
        });
      },
    });
    if (result.phase === "done") {
      outcome.done += 1;
      bytesBefore += item.size;
      if (trackLanding) {
        const after = await listNames(destDir);
        const added = after.filter((name) => !before.includes(name));
        // 正好一项：要么名字没变（覆盖，或没触发改名），要么后端按「保留两者」改了名。
        const landed = added.length === 1 ? added[0] : item.name;
        outcome.moved.push({ from: item.path, to: joinPath(destDir, landed) });
      }
      continue;
    }
    if (result.phase === "cancelled") {
      outcome.cancelled = true;
      break;
    }
    outcome.failure = { reason: result.reason, message: result.message };
    break;
  }
  onProgress({
    label: "",
    done: outcome.done,
    total: items.length,
    bytes: bytesBefore,
    totalBytes,
  });
  return outcome;
}

/**
 * 把已经搬过去的项搬回原位（导入 ROM 取消时用）。
 *
 * 为什么要「搬回去」而不是「让用户自己找」：用户按了取消，期望的是**什么都没发生**。
 * 一半在下载夹、一半在模拟器目录，是掌机上最难收拾的烂摊子（改造包原话）。
 * 落点用「跳过同名」：绝不覆盖用户后来放进去的东西，宁可留一个搬不回去的如实报出来。
 */
export async function rollbackTransfer(
  moved: { from: string; to: string }[],
): Promise<{ moved: number; failed: number }> {
  let done = 0;
  let failed = 0;
  for (const entry of moved) {
    try {
      await invoke("file_transfer", {
        id: `rollback-${Date.now().toString(36)}-${sequence++}`,
        items: [entry.to],
        destDir: parentDirOf(entry.from),
        mode: "move",
        conflict: "skip",
      });
      done += 1;
    } catch {
      failed += 1;
    }
  }
  return { moved: done, failed };
}
