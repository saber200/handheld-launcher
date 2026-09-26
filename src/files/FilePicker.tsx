import { useEffect, useRef } from "react";
import { setFileActions } from "./actions";
import { useFileBrowser, type FileEntry } from "./useFileBrowser";

type Props = {
  title: string;
  onClose: () => void;
  onPick: (file: { name: string; path: string }) => void;
};

function canLaunch(entry: FileEntry, preview: boolean) {
  if (entry.kind !== "file") return false;
  if (preview) return true;
  return entry.name.toLowerCase().endsWith(".exe");
}

export function FilePicker({ title, onClose, onPick }: Props) {
  const files = useFileBrowser();
  const listRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setFileActions({
      blocksTabs: () => true,
      dismiss: () => onCloseRef.current(),
      back: () => {
        if (files.up()) return true;
        onCloseRef.current();
        return true;
      },
    });
    return () => setFileActions({});
  }, [files.up]);

  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest(".file-picker-panel")) return;
    listRef.current?.querySelector<HTMLElement>("[data-focusable]")?.focus();
  }, [files.location, files.entries]);

  function choose(entry: FileEntry) {
    if (entry.kind === "dir") {
      files.enter(entry);
      return;
    }
    if (!canLaunch(entry, files.preview)) {
      files.setNote("请选择 .exe 程序。");
      return;
    }
    onPick({ name: entry.name, path: entry.path });
  }

  const hint =
    files.note ||
    (files.preview
      ? "浏览器预览可以选任意文件。A 进入文件夹或选中，B 返回。"
      : "A 进入文件夹，或选中 .exe。B 返回，到盘符再按 B 关闭。");

  return (
    <div className="group-dialog focus-trap open">
      <button type="button" className="drawer-scrim" aria-label="关闭" tabIndex={-1} onClick={onClose} />
      <div className="group-dialog-panel file-picker-panel" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <p className="preview-note">{files.pathLabel}</p>
        <div className="library-tools" data-focus-zone="files-tools">
          {files.location != null && (
            <button type="button" className="library-tool" data-focusable onClick={() => files.up()}>
              返回上一级
            </button>
          )}
        </div>
        {files.entries.length === 0 ? (
          <p className="group-empty">这个文件夹是空的。</p>
        ) : (
          <div className="file-list file-picker-list" data-focus-zone="files-list" ref={listRef}>
            {files.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="file-row"
                data-focusable
                onClick={() => choose(entry)}
              >
                <span className={entry.kind === "dir" ? "file-mark is-dir" : "file-mark"} aria-hidden>
                  {entry.kind === "dir" ? "夹" : "文"}
                </span>
                <span className="file-name">{entry.name}</span>
              </button>
            ))}
          </div>
        )}
        <p className="preview-note">{hint}</p>
      </div>
    </div>
  );
}
