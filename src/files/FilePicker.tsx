import { useEffect, useRef } from "react";
import { setFileActions } from "./actions";
import { useFileBrowser, type FileEntry } from "./useFileBrowser";
import { text } from "../i18n";

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
      files.setNote(text().files.exeOnly);
      return;
    }
    onPick({ name: entry.name, path: entry.path });
  }

  const hint =
    files.note ||
    (files.preview
      ? text().files.pickerPreview
      : text().files.pickerNative);

  return (
    <div className="group-dialog focus-trap open">
      <button type="button" className="drawer-scrim" aria-label={text().close} tabIndex={-1} onClick={onClose} />
      <div className="group-dialog-panel file-picker-panel" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <p className="preview-note">{files.pathLabel}</p>
        <div className="library-tools" data-focus-zone="files-tools">
          {files.location != null && (
            <button type="button" className="library-tool" data-focusable onClick={() => files.up()}>
              {text().files.up}
            </button>
          )}
        </div>
        {files.entries.length === 0 ? (
          <p className="group-empty">{text().files.emptyFolder}</p>
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
                  {entry.kind === "dir" ? text().files.dirMark : text().files.fileMark}
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
