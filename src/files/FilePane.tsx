import type { RefObject } from "react";
import { text } from "../i18n";
import { FileIcon, FolderIcon } from "../components/NavIcons";
import { THUMB_LIST, isImageName, useThumb } from "./thumbs";
import type { DirSize, FileEntry, SortKey, useFileBrowser } from "./useFileBrowser";

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
  /** 当前排序列：表头要在对应那一列上显示箭头。 */
  sortKey: SortKey;
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

/** 页面头部（单栏）与双栏每栏自己那一行共用的面包屑。 */
export function FileCrumbs({ browser, zone }: { browser: Browser; zone: string }) {
  return (
    <nav className="k7-crumbs" data-focus-zone={`${zone}-crumbs`} aria-label={text().files.pathHere}>
      {browser.crumbs.map((crumb, index) => {
        const here = index === browser.crumbs.length - 1;
        return (
          <span key={`${crumb.path ?? "places"}-${index}`} className="k7-crumbs-item">
            {index > 0 && (
              <span className="k7-crumb-sep" aria-hidden>
                ›
              </span>
            )}
            <button
              type="button"
              className={here ? "k7-crumb is-here" : "k7-crumb"}
              data-focusable
              disabled={here}
              onClick={() => browser.jump(crumb.path)}
            >
              {crumb.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export function FilePane({
  browser,
  pane,
  zone,
  active,
  dual,
  layout,
  sortKey,
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
  // 表头那三列显示的是「排序列」的名字：点开排序行才看得到四个键，表头得说明现在按哪一列排。
  const columns = [
    { key: "name" as const, label: text().files.sortName },
    { key: "size" as const, label: text().files.sortSize },
    { key: "time" as const, label: text().files.propModified },
  ];
  return (
    <section
      className={dual && active ? "k7-pane is-active" : "k7-pane"}
      data-pane={pane}
      aria-label={browser.pathLabel}
      // 手柄移动焦点、鼠标点进来，都算「这一栏现在是当前栏」——
      // 工具栏按钮和粘贴目标都跟着它走。
      onFocusCapture={onActivatePane}
      onMouseDown={onActivatePane}
    >
      {dual && (
        <div className="k7-pane-head">
          <span className={active ? "k7-pane-tag is-current" : "k7-pane-tag"}>
            {pane === "left" ? text().files.leftPane : text().files.rightPane}
          </span>
          <span className="k7-pane-path" title={browser.pathLabel}>
            {browser.pathLabel}
          </span>
        </div>
      )}
      {/* 单栏时面包屑在页面头部（画板 K7 的面包屑横跨内容区、位置栏在它下面）；
          双栏时每栏各显示自己的，免得两栏看着像同一个目录。 */}
      {dual && <FileCrumbs browser={browser} zone={zone} />}
      <div className="k7-table-head" aria-hidden>
        {columns.map(({ key, label }) => (
          <span key={key} className={sortKey === key ? "is-current" : undefined}>
            {label}
            {sortKey === key ? (browser.sortDir === "asc" ? " ↑" : " ↓") : ""}
          </span>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="k7-empty">{text().files.emptyHint}</p>
      ) : (
        <div
          className={layout === "grid" ? "k7-grid motion-stagger" : "k7-list motion-stagger"}
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
  const glyph = entry.kind === "dir" ? <FolderIcon /> : <FileIcon />;
  // 图片行显示真缩略图（改造包 §3.1 的 32×32 块）。只对图片要，别的类型问也白问；
  // 失败/还没好就退回图标 —— 文件列表永远不该等一张图。
  const thumb = useThumb(
    entry.kind === "file" && isImageName(entry.name) ? entry.path : null,
    THUMB_LIST,
  );
  const face = thumb.src ? (
    <img className={grid ? "k7-tile-thumb" : "k7-row-thumb"} src={thumb.src} alt="" />
  ) : (
    <span
      className={
        grid ? (entry.kind === "dir" ? "k7-tile-face is-dir" : "k7-tile-face") : "k7-row-icon"
      }
      aria-hidden
    >
      {glyph}
    </span>
  );
  return (
    <div className={grid ? "k7-tile-wrap" : "k7-row-wrap"}>
      {/* 勾选框只在选择模式里出现：画板 K7 的行是「图标 + 名称 + 大小 + 时间」四列，
          平时挂一个 22dp 的框会把图标从 x+13 顶到 x+43，行就跟表头对不上了。
          鼠标多选没丢：Ctrl / Shift + 单击照样选（见下面 onClick）。 */}
      {selectMode && (
        <button
          type="button"
          className={picked ? "k7-check on" : "k7-check"}
          tabIndex={-1}
          aria-label={picked ? text().files.unselect(entry.name) : text().files.select(entry.name)}
          aria-pressed={picked}
          onClick={() => onPick(index)}
        >
          {picked ? "✓" : ""}
        </button>
      )}
      <button
        ref={index === 0 ? firstRef : undefined}
        type="button"
        className={`${grid ? "k7-tile" : "k7-row"}${picked ? " is-picked" : ""}${
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
        {grid ? (
          <>
            {face}
            <span className="k7-tile-name">{entry.name}</span>
          </>
        ) : (
          <>
            <span className="k7-row-main">
              {face}
              <span className="k7-row-name">{entry.name}</span>
            </span>
            <span className="k7-row-size tnum">{formatSize(entry, size)}</span>
            <span className="k7-row-time tnum">{formatTime(entry.modified)}</span>
          </>
        )}
      </button>
    </div>
  );
}

