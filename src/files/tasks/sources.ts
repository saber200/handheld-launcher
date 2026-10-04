/*
 * 来源候选项：几个任务（导入 ROM / 处理截图 / 备份存档…）第 1 步问的是同一件事
 * 「从哪个文件夹开始」，列表也就那几处，集中在这儿免得各写一份、各漏一个。
 */
import { text } from "../../i18n";
import { externalDrives } from "./env";
import type { TaskCtx, TaskSource } from "./types";

/**
 * 常用来源。`extra` 是任务自己的补充项（截图目录、备份目录、ROM 根），
 * 排在常用目录后面 —— 对「导入 ROM」来说下载夹比 ROM 根更可能是来源。
 */
export async function commonSources(
  ctx: TaskCtx,
  extra: { value: string; label: string }[] = [],
): Promise<TaskSource["options"]> {
  const t = text().tasks;
  const out: TaskSource["options"] = [];
  const push = (value: string, label: string) => {
    if (value && !out.some((row) => row.value === value)) out.push({ value, label });
  };
  push(ctx.dirs.downloads, t.srcDownloads);
  push(ctx.dirs.desktop, t.srcDesktop);
  push(ctx.dirs.documents, t.srcDocuments);
  push(ctx.dirs.pictures, t.srcPictures);
  for (const drive of await externalDrives(ctx)) push(drive.path, t.srcDevice(drive.name));
  for (const row of extra) push(row.value, row.label);
  return out;
}
