/*
 * 快速预览面板（改造包 §3，画板 F2）。
 *
 * 这件事的全部意义是「焦点一动就更新，不用按 A」。所以：
 *   - 入参只有一个 entry，父组件在焦点行变化时把它换掉；
 *   - 所有异步读取都带 150ms 防抖 + 过期丢弃（`alive` 标记），快速滚动不会打出一串请求；
 *   - 读不出来的东西一律退回「原始信息 + 一句人话」，不崩、也不一直转圈。
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { FileIcon, FolderIcon } from "../components/NavIcons";
import { text } from "../i18n";
import { gameCoverFor } from "../library/useLocalLibrary";
import { formatBytes, formatTime } from "./tasks/env";
import { platformOf } from "./taskMeta";
import { THUMB_PREVIEW, isImageName, useThumb } from "./thumbs";
import { isArchiveName, type DirSize, type FileEntry } from "./useFileBrowser";

/** 预览防抖：画板要求 150ms（快速滚动不卡）。 */
const DEBOUNCE_MS = 150;
/** 文本预览、压缩包条数都取前 20 项。 */
const PREVIEW_LINES = 20;

type Loaded =
  | { kind: "text"; lines: string[] }
  | { kind: "archive"; rows: { name: string; bytes: number; dir: boolean }[]; more: number }
  | {
      kind: "dir";
      count: number;
      bytes: number;
      complete: boolean;
      /** 这个目录就是库里的某个游戏时，带上它的封面（功能 15 第 5 条）。 */
      game: { name: string; cover: string } | null;
    }
  | { kind: "none" };

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function PreviewPanel({
  entry,
  size,
  onOpen,
  onDelete,
}: {
  entry: FileEntry | null;
  size?: DirSize;
  onOpen: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}) {
  const t = text().tasks;
  const [extra, setExtra] = useState<Loaded>({ kind: "none" });
  const image = Boolean(entry && entry.kind === "file" && isImageName(entry.name));
  const thumb = useThumb(image && entry ? entry.path : null, THUMB_PREVIEW);
  const platform = entry ? platformOf(entry.name) : null;
  /** 游戏目录的封面：库里的缓存文件，直接喂给 `<img src>`（不用再过一遍解码）。 */
  const cover = extra.kind === "dir" ? extra.game : null;

  useEffect(() => {
    if (!entry) {
      setExtra({ kind: "none" });
      return;
    }
    let alive = true;
    const timer = window.setTimeout(async () => {
      if (entry.kind === "dir") {
        try {
          const props = await invoke<{ bytes: number; sizeComplete: boolean }>("file_properties", {
            path: entry.path,
          });
          const rows = await invoke<FileEntry[]>("file_list", { path: entry.path });
          if (alive) {
            setExtra({
              kind: "dir",
              count: rows.length,
              bytes: props.bytes,
              complete: props.sizeComplete,
              // 库里扫过的游戏目录才有封面；没扫到就是 null，界面照旧显示子项数。
              game: gameCoverFor(entry.path),
            });
          }
        } catch {
          if (alive) setExtra({ kind: "none" });
        }
        return;
      }
      if (isArchiveName(entry.name)) {
        try {
          // `listOnly`：只看目录、不解压。为了预览真解压一遍，用户只是浏览文件，
          // 磁盘上却会多出一堆目录。
          const out = await invoke<{ entries: { name: string; bytes: number; dir: boolean }[] }>(
            "file_extract",
            { archive: entry.path, listOnly: true },
          );
          if (alive) {
            setExtra({
              kind: "archive",
              rows: out.entries.slice(0, PREVIEW_LINES),
              more: Math.max(0, out.entries.length - PREVIEW_LINES),
            });
          }
        } catch {
          if (alive) setExtra({ kind: "none" });
        }
        return;
      }
      if (/\.(txt|md|json|log|ini|cfg|conf|yml|yaml|xml|csv)$/i.test(entry.name)) {
        try {
          const body = await invoke<string>("file_read_text", { path: entry.path });
          if (alive) setExtra({ kind: "text", lines: body.split(/\r?\n/).slice(0, PREVIEW_LINES) });
        } catch {
          if (alive) setExtra({ kind: "none" });
        }
        return;
      }
      if (alive) setExtra({ kind: "none" });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [entry]);

  return (
    <section className="ft-preview" aria-label={t.previewTitle} aria-live="polite">
      <header className="ft-preview-head">
        <h2>{t.previewTitle}</h2>
        <span className="ft-preview-auto">{t.previewAuto}</span>
      </header>

      {!entry ? (
        <p className="ft-preview-empty">{t.previewEmpty}</p>
      ) : (
        <>
          <div className="ft-preview-stage">
            {image && thumb.src ? (
              <img className="ft-preview-image" src={thumb.src} alt={entry.name} />
            ) : cover ? (
              // 封面是竖图，用 `ft-preview-cover` 单独控制（object-fit: cover），
              // 免得横向拉伸成一张「胖封面」。
              <img className="ft-preview-cover" src={cover.cover} alt={cover.name} />
            ) : (
              <span className="ft-preview-placeholder" aria-hidden>
                {entry.kind === "dir" ? <FolderIcon /> : <FileIcon />}
              </span>
            )}
            <span className="ft-preview-tag">
              {platform ??
                (entry.kind === "dir"
                  ? cover
                    ? t.previewGame
                    : t.previewDir
                  : extension(entry.name) || "—")}
              {image && (thumb.loading || thumb.failed) && (
                <em className="ft-preview-note">
                  {thumb.loading ? t.previewLoading : t.previewTooBig}
                </em>
              )}
            </span>
          </div>

          <p className="ft-preview-name">{entry.name}</p>

          <dl className="ft-preview-facts">
            <div>
              <dt>{t.previewKey}</dt>
              <dd className="tnum">
                {entry.kind === "dir"
                  ? size
                    ? `${formatBytes(size.bytes)}${size.complete ? "" : "+"}`
                    : "—"
                  : formatBytes(entry.bytes)}
              </dd>
            </div>
            <div>
              <dt>{t.previewType}</dt>
              <dd>{entry.kind === "dir" ? t.previewDir : extension(entry.name) || "—"}</dd>
            </div>
            <div>
              <dt>{text().files.propModified}</dt>
              <dd className="tnum">{formatTime(entry.modified) || text().files.unknown}</dd>
            </div>
            <div>
              <dt>{t.previewLocation}</dt>
              <dd className="ft-preview-path">{entry.path}</dd>
            </div>
          </dl>

          <div className="ft-preview-body">
            {extra.kind === "text" && (
              <>
                <p className="ft-preview-label">{t.previewText}</p>
                <pre className="ft-preview-text">{extra.lines.join("\n")}</pre>
              </>
            )}
            {extra.kind === "archive" && (
              <>
                <p className="ft-preview-label">{t.previewArchive}</p>
                <ul className="ft-preview-list">
                  {extra.rows.map((row, index) => (
                    <li key={`${row.name}-${index}`}>
                      <span className="ft-preview-item">{row.name}</span>
                      <span className="tnum">{row.dir ? t.previewDir : formatBytes(row.bytes)}</span>
                    </li>
                  ))}
                </ul>
                {extra.more > 0 && (
                  <p className="ft-preview-label">{t.previewArchiveMore(extra.more)}</p>
                )}
              </>
            )}
            {extra.kind === "dir" && (
              <>
                <p className="ft-preview-label">
                  {t.previewDirCount(
                    extra.count,
                    `${formatBytes(extra.bytes)}${extra.complete ? "" : "+"}`,
                  )}
                </p>
                {extra.game && (
                  <p className="ft-preview-label">
                    {t.previewCover} · {extra.game.name}
                  </p>
                )}
              </>
            )}
            {/* 认不出平台的普通文件、也读不出内容的，就只说一句「预览不了」 */}
            {extra.kind === "none" && !image && !platform && entry.kind === "file" && (
              <p className="ft-preview-label">{t.previewFailed}</p>
            )}
            {platform && entry.kind === "file" && (
              <p className="ft-preview-label">{t.previewRom}</p>
            )}
          </div>

          <div className="ft-preview-actions">
            <button type="button" className="ft-btn" data-focusable onClick={() => onOpen(entry)}>
              {t.previewOpen}
            </button>
            <button
              type="button"
              className="ft-btn is-danger"
              data-focusable
              onClick={() => onDelete(entry)}
            >
              {t.previewDelete}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
