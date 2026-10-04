import type { RefObject } from "react";
import { text } from "../i18n";
import type { DirSize, FileEntry, useFileBrowser } from "./useFileBrowser";

export type FileLayout = "list" | "grid";

export type Browser = ReturnType<typeof useFileBrowser>;

type Props = {
  browser: Browser;
  /** `left` 是左栏（单栏时就是它）；`right` 只在双栏时出现。 */
  pane: "left" | "right";
  /** 手柄焦点池：左右两栏各一个，靠 LT / RT 换栏。 */
  zone: string;
  active: boolean;
  dual: boolean;
  layout: FileLayout;
  picked: string[];
  /** 文件夹大小（按路径索引；还没算出来的不在里面）。 */
  sizes: Record<string, DirSize>;
  selectMode: boolean;
  firstRef: RefObject<HTMLButtonElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  onActivatePane: () => void;
  onFocusRow: (index: number) => void;
  onPick: (index: number, options?: { range?: boolean }) => void;
  onOpen: (entry: FileEntry) => void;
  onMenu: (entry: FileEntry) => void;
  onDragStart: (entry: FileEntry) => void;
  onDrop: (folder: FileEntry) => void;
};

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatSize(entry: FileEntry, dir?: DirSize) {
  if (entry.kind !== "dir") return formatBytes(entry.bytes);
  // 文件夹的大小要走一遍盘，是**后台补上来**的（见 useFileBrowser 的 dirSizes）：
  // 还没算出来就先写着「文件夹」，算不完的标「≥」（和属性面板一个口径，不装成准数）。
  if (!dir) return text().files.folder;
  if (!dir.complete) {
    return dir.bytes > 0 ? text().files.sizeAtLeast(formatBytes(dir.bytes)) : text().files.folder;
  }
  return formatBytes(dir.bytes);
}

/** 时间戳（毫秒）→ 本机习惯的显示。取不到时间就返回「未知」。 */
export function formatTime(ms: number) {
  if (!ms) return text().files.unknown;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return text().files.unknown;
  }
}

export function FilePane({
  browser,
  pane,
  zone,
  active,
  dual,
  layout,
  picked,
  sizes,
  selectMode,
  firstRef,
  listRef,
  onActivatePane,
  onFocusRow,
  onPick,
  onOpen,
  onMenu,
  onDragStart,
  onDrop,
}: Props) {
  const rows = browser.entries;
  return (
    <section
      className={`file-pane${active ? " is-active" : ""}`}
      data-pane={pane}
      aria-label={browser.pathLabel}
      // 手柄移动焦点、鼠标点进来，都算「这一栏现在是当前栏」——
      // 工具栏按钮和粘贴目标都跟着它走。
      onFocusCapture={onActivatePane}
      onMouseDown={onActivatePane}
    >
      {dual && (
        <div className="file-pane-head">
          <span className={active ? "file-pane-tag is-current" : "file-pane-tag"}>
            {pane === "left" ? text().files.leftPane : text().files.rightPane}
          </span>
          <span className="file-pane-path" title={browser.pathLabel}>
            {browser.pathLabel}
          </span>
        </div>
      )}
      <nav className="file-crumbs" data-focus-zone={`${zone}-crumbs`} aria-label={text().files.pathHere}>
        {browser.crumbs.map((crumb, index) => {
          const here = index === browser.crumbs.length - 1;
          return (
            <button
              key={`${crumb.path ?? "places"}-${index}`}
              type="button"
              className={here ? "file-crumb is-here" : "file-crumb"}
              data-focusable
              disabled={here}
              onClick={() => browser.jump(crumb.path)}
            >
              {crumb.label}
            </button>
          );
        })}
      </nav>
      {rows.length === 0 ? (
        <p className="group-empty">{text().files.emptyHint}</p>
      ) : (
        <div
          className={layout === "grid" ? "library-grid file-grid motion-stagger" : "file-list motion-stagger"}
          data-focus-zone={zone}
          ref={listRef}
        >
          {rows.map((entry, index) => (
            <FileRow
              key={entry.path}
              entry={entry}
              index={index}
              layout={layout}
              picked={picked.includes(entry.path)}
              size={sizes[entry.path]}
              selectMode={selectMode}
              firstRef={firstRef}
              onFocusRow={onFocusRow}
              onPick={onPick}
              onOpen={onOpen}
              onMenu={onMenu}
              onDragStart={onDragStart}
              onDrop={onDrop}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type RowProps = {
  entry: FileEntry;
  index: number;
  layout: FileLayout;
  picked: boolean;
  size?: DirSize;
  selectMode: boolean;
  firstRef: RefObject<HTMLButtonElement | null>;
  onFocusRow: (index: number) => void;
  onPick: (index: number, options?: { range?: boolean }) => void;
  onOpen: (entry: FileEntry) => void;
  onMenu: (entry: FileEntry) => void;
  onDragStart: (entry: FileEntry) => void;
  onDrop: (folder: FileEntry) => void;
};

function FileRow({
  entry,
  index,
  layout,
  picked,
  size,
  selectMode,
  firstRef,
  onFocusRow,
  onPick,
  onOpen,
  onMenu,
  onDragStart,
  onDrop,
}: RowProps) {
  const grid = layout === "grid";
  return (
    <div className={grid ? "file-tile-wrap" : "file-line"}>
      <button
        type="button"
        className={picked ? "file-check on" : "file-check"}
        tabIndex={-1}
        aria-label={picked ? text().files.unselect(entry.name) : text().files.select(entry.name)}
        aria-pressed={picked}
        onClick={() => onPick(index)}
      >
        {picked ? "✓" : ""}
      </button>
      <button
        ref={index === 0 ? firstRef : undefined}
        type="button"
        className={`${grid ? "file-tile" : "file-row"}${picked ? " is-picked" : ""}${
          entry.kind === "dir" ? " is-dir" : ""
        }`}
        data-focusable
        data-file-name={entry.name}
        data-file-index={index}
        draggable
        onDragStart={() => onDragStart(entry)}
        onDragOver={(event) => {
          // 只有文件夹才接：拖到文件上松手，什么都不该发生。
          if (entry.kind === "dir") event.preventDefault();
        }}
        onDrop={(event) => {
          if (entry.kind !== "dir") return;
          event.preventDefault();
          onDrop(entry);
        }}
        onFocus={() => onFocusRow(index)}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(entry);
        }}
        onClick={(event) => {
          // 鼠标用 Ctrl / Shift 多选；手柄没有修饰键，所以手柄走「选择模式」
          // （见 FilesPage 的 selectMode）。
          if (event.ctrlKey || event.metaKey || event.shiftKey) {
            event.preventDefault();
            onPick(index, { range: event.shiftKey });
            return;
          }
          if (selectMode) {
            event.preventDefault();
            onPick(index);
            return;
          }
          onOpen(entry);
        }}
      >
        <span
          className={
            grid
              ? entry.kind === "dir"
                ? "file-tile-face is-dir"
                : "file-tile-face"
              : entry.kind === "dir"
                ? "file-mark is-dir"
                : "file-mark"
          }
          aria-hidden
        >
          {entry.kind === "dir" ? text().files.dirMark : text().files.fileMark}
        </span>
        <span className={grid ? "library-name" : "file-name"}>{entry.name}</span>
        {!grid && <span className="file-size">{formatSize(entry, size)}</span>}
      </button>
    </div>
  );
}

