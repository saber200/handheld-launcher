/*
 * 选一个文件夹（向导第 2 步的「目标位置」用）。
 *
 * 为什么不复用 `FilePicker`：那个是「选一个 .exe 去启动」，只能挑文件、挑不了「当前所在的
 * 这个文件夹」。目标位置恰恰总是文件夹，所以另开一个 —— 但长相与操作（B 返回、A 进入、
 * 焦点自动落第一行）保持一致，用户不该在两个几乎一样的框里学两套操作。
 */
import { useEffect, useRef } from "react";
import { text } from "../i18n";
import { setFileActions } from "./actions";
import { useFileBrowser } from "./useFileBrowser";

export function FolderPicker({
  title,
  start,
  onClose,
  onPick,
}: {
  title: string;
  /** 打开时想直接落在哪个目录（可能不存在：那就在当前目录等用户自己走）。 */
  start?: string;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const t = text().tasks;
  const browser = useFileBrowser({ cacheKey: "folder-picker", measureDirSizes: false });
  const listRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const jumpRef = useRef(browser.jump);
  jumpRef.current = browser.jump;
  const jumped = useRef(false);

  useEffect(() => {
    setFileActions({
      blocksTabs: () => true,
      dismiss: () => onCloseRef.current(),
      back: () => {
        if (browser.up()) return true;
        onCloseRef.current();
        return true;
      },
    });
    return () => setFileActions({});
  }, [browser.up]);

  // 只跳一次：每次渲染都跳的话，用户在对话框里翻到别的目录会被立刻拽回来。
  useEffect(() => {
    if (jumped.current) return;
    jumped.current = true;
    if (start) void jumpRef.current(start);
  }, [start]);

  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest(".ft-picker-panel")) return;
    listRef.current?.querySelector<HTMLElement>("[data-focusable]")?.focus();
  }, [browser.location, browser.entries]);

  const folders = browser.entries.filter((row) => row.kind === "dir");

  return (
    <div className="group-dialog focus-trap open">
      <button
        type="button"
        className="drawer-scrim"
        aria-label={text().close}
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="group-dialog-panel ft-picker-panel" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <p className="preview-note">{browser.pathLabel}</p>
        <div className="library-tools" data-focus-zone="ft-picker-tools">
          {browser.location != null && (
            <button type="button" className="library-tool" data-focusable onClick={() => browser.up()}>
              {text().files.up}
            </button>
          )}
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={!browser.location}
            onClick={() => browser.location && onPick(browser.location)}
          >
            {t.targetPick}
          </button>
        </div>
        {folders.length === 0 ? (
          <p className="group-empty">{text().files.emptyFolder}</p>
        ) : (
          <div className="file-list ft-picker-list" data-focus-zone="ft-picker-list" ref={listRef}>
            {folders.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="file-row"
                data-focusable
                onClick={() => browser.enter(entry)}
              >
                <span className="file-mark is-dir" aria-hidden>
                  {text().files.dirMark}
                </span>
                <span className="file-name">{entry.name}</span>
              </button>
            ))}
          </div>
        )}
        <p className="preview-note">{browser.note || t.targetPick}</p>
      </div>
    </div>
  );
}
