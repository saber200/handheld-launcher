import { useEffect, useRef, useState } from "react";
import { setFileActions } from "../files/actions";
import { useFileBrowser, type FileEntry } from "../files/useFileBrowser";
import { text } from "../i18n";

type Naming = "dir" | "file" | null;
type EditorState = { path: string; name: string; text: string };
type FileLayout = "list" | "grid";

function loadLayout(): FileLayout {
  return localStorage.getItem("handheld-launcher.files.layout") === "grid" ? "grid" : "list";
}

function formatBytes(bytes: number, kind: string) {
  if (kind === "dir") return text().files.folder;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FilesPage() {
  const files = useFileBrowser();
  const [naming, setNaming] = useState<Naming>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<FileEntry | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [layout, setLayout] = useState<FileLayout>(loadLayout);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [trash, setTrash] = useState<FileEntry[] | null>(null);
  const overlay = useRef({ menu: false, naming: false, editor: false, trash: false });
  const listRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const newFolderRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const trashCancelRef = useRef<HTMLButtonElement>(null);
  overlay.current = {
    menu: menu !== null,
    naming: naming !== null,
    editor: editor !== null,
    trash: trash !== null,
  };

  useEffect(() => {
    setFileActions({
      blocksTabs: () =>
        overlay.current.menu || overlay.current.naming || overlay.current.editor || overlay.current.trash,
      dismiss: () => {
        setMenu(null);
        setNaming(null);
        setEditor(null);
        setTrash(null);
        setDraft("");
      },
      openMenu: () => {
        if (overlay.current.menu || overlay.current.naming || overlay.current.editor || overlay.current.trash) {
          return false;
        }
        const name = (document.activeElement as HTMLElement | null)
          ?.closest("[data-file-name]")
          ?.getAttribute("data-file-name");
        const entry = files.entries.find((item) => item.name === name);
        if (!entry) return false;
        setMenu(entry);
        return true;
      },
      toggleSelect: () => {
        if (overlay.current.menu || overlay.current.naming || overlay.current.editor || overlay.current.trash) {
          return false;
        }
        const name = (document.activeElement as HTMLElement | null)
          ?.closest("[data-file-name]")
          ?.getAttribute("data-file-name");
        const entry = files.entries.find((item) => item.name === name);
        if (!entry) return false;
        setPicked((current) =>
          current.includes(entry.path) ? current.filter((path) => path !== entry.path) : [...current, entry.path],
        );
        return true;
      },
      back: () => {
        const active = document.activeElement;
        if (overlay.current.trash) {
          setTrash(null);
          return true;
        }
        if (overlay.current.editor) {
          if (active instanceof HTMLTextAreaElement) {
            saveRef.current?.focus();
            return true;
          }
          setEditor(null);
          return true;
        }
        if (overlay.current.naming) {
          if (active instanceof HTMLInputElement) {
            createRef.current?.focus();
            return true;
          }
          setNaming(null);
          setDraft("");
          return true;
        }
        if (overlay.current.menu) {
          setMenu(null);
          return true;
        }
        return files.up();
      },
    });
    return () => setFileActions({});
  }, [files.entries, files.up]);

  useEffect(() => {
    setPicked([]);
  }, [files.location]);

  function chooseLayout(next: FileLayout) {
    setLayout(next);
    localStorage.setItem("handheld-launcher.files.layout", next);
  }

  function togglePath(path: string) {
    setPicked((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
  }

  useEffect(() => {
    if (menu || naming || editor) return;
    if (files.pendingFocus) {
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-file-name="${CSS.escape(files.pendingFocus)}"]`,
      );
      if (el) {
        el.focus();
        files.clearPendingFocus();
        return;
      }
    }
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest("[data-focus-zone='files-tools'], [data-focus-zone='files-list'], [data-focus-zone='files-view']")) return;
    (firstRef.current ?? newFolderRef.current)?.focus();
  }, [editor, files, menu, naming]);

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const onFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (root.contains(target)) target?.scrollIntoView({ block: "nearest" });
    };
    root.addEventListener("focusin", onFocus);
    return () => root.removeEventListener("focusin", onFocus);
  }, []);

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);

  useEffect(() => {
    if (!menu) return;
    document.querySelector<HTMLElement>(".file-menu [data-focusable]")?.focus();
  }, [menu]);

  useEffect(() => {
    if (editor) editorRef.current?.focus();
  }, [editor?.path]);

  useEffect(() => {
    if (trash) trashCancelRef.current?.focus();
  }, [trash]);

  async function submitName() {
    if (!naming) return;
    try {
      if (naming === "dir") {
        await files.createDir(draft);
      } else {
        const path = await files.createFile(draft);
        setEditor({ path, name: draft.trim(), text: "" });
      }
      setNaming(null);
      setDraft("");
    } catch (err) {
      files.setNote(typeof err === "string" ? err : text().files.cannotCreate);
    }
  }

  async function edit(entry: FileEntry) {
    try {
      const text = await files.readText(entry);
      setMenu(null);
      setEditor({ path: entry.path, name: entry.name, text });
    } catch (err) {
      setMenu(null);
      files.setNote(typeof err === "string" ? err : text().files.cannotEdit);
    }
  }

  function activate(entry: FileEntry) {
    setMenu(null);
    if (entry.kind === "dir") {
      files.enter(entry);
      return;
    }
    void files.openExternal(entry).catch((err: unknown) => {
      files.setNote(typeof err === "string" ? err : text().files.cannotOpen);
    });
  }

  function selectAll() {
    const paths = files.entries.map((entry) => entry.path);
    const every = paths.length > 0 && paths.every((path) => picked.includes(path));
    setPicked(every ? [] : paths);
  }

  const hint =
    files.note ||
    (picked.length > 0
      ? text().files.pickedHint(picked.length)
      : files.preview
        ? text().files.previewHint
        : text().files.browseHint);

  const menuTargets =
    menu == null
      ? []
      : files.entries.filter((entry) => picked.includes(entry.path)).length > 0
        ? files.entries.filter((entry) => picked.includes(entry.path))
        : [menu];

  return (
    <main className="page library-page">
      <div className="library-head">
        <div className="files-title-row">
          <div className="group-switch" aria-live="polite">
            <span className="group-switch-side">B</span>
            <strong className="group-switch-name">{files.title}</strong>
            <span className="group-switch-side">{files.location == null ? text().files.drives : text().files.back}</span>
          </div>
          <div className="file-view-toggle" data-focus-zone="files-view" role="group" aria-label={text().files.viewMode}>
            <button
              type="button"
              className={layout === "list" ? "file-view is-current" : "file-view"}
              data-focusable
              aria-label={text().files.list}
              aria-pressed={layout === "list"}
              onClick={() => chooseLayout("list")}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className={layout === "grid" ? "file-view is-current" : "file-view"}
              data-focusable
              aria-label={text().files.grid}
              aria-pressed={layout === "grid"}
              onClick={() => chooseLayout("grid")}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <rect x="2" y="2" width="5.5" height="5.5" rx="1" fill="currentColor" />
                <rect x="10.5" y="2" width="5.5" height="5.5" rx="1" fill="currentColor" />
                <rect x="2" y="10.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
                <rect x="10.5" y="10.5" width="5.5" height="5.5" rx="1" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
        <div className="library-tools" data-focus-zone="files-tools">
          <button
            ref={newFolderRef}
            type="button"
            className="library-tool"
            data-focusable
            disabled={files.location == null}
            onClick={() => {
              setDraft("");
              setNaming("dir");
            }}
          >
            {text().files.newFolder}
          </button>
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={files.location == null}
            onClick={() => {
              setDraft("");
              setNaming("file");
            }}
          >
            {text().files.newFile}
          </button>
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={files.clip == null || files.location == null}
            onClick={() => void files.paste()}
          >
            {text().files.paste}
          </button>
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={files.entries.length === 0}
            onClick={selectAll}
          >
            {files.entries.length > 0 && files.entries.every((entry) => picked.includes(entry.path)) ? text().files.clearSelection : text().files.selectAll}
          </button>
          {files.location != null && (
            <button type="button" className="library-tool" data-focusable onClick={() => files.up()}>
              {text().files.up}
            </button>
          )}
        </div>
        <p className="preview-note">{files.pathLabel}</p>
        <p className="preview-note">{hint}</p>
      </div>
      {files.entries.length === 0 ? (
        <p className="group-empty">{text().files.emptyHint}</p>
      ) : (
        <div
          className={layout === "grid" ? "library-grid file-grid" : "file-list"}
          data-focus-zone="files-list"
          ref={listRef}
        >
          {files.entries.map((entry, index) => {
            const on = picked.includes(entry.path);
            return (
              <div key={entry.path} className={layout === "grid" ? "file-tile-wrap" : "file-line"}>
                <button
                  type="button"
                  className={on ? "file-check on" : "file-check"}
                  tabIndex={-1}
                  aria-label={on ? text().files.unselect(entry.name) : text().files.select(entry.name)}
                  aria-pressed={on}
                  onClick={() => togglePath(entry.path)}
                >
                  {on ? "✓" : ""}
                </button>
                <button
                  ref={index === 0 ? firstRef : undefined}
                  type="button"
                  className={`${layout === "grid" ? "file-tile" : "file-row"}${on ? " is-picked" : ""}`}
                  data-focusable
                  data-file-name={entry.name}
                  onClick={() => activate(entry)}
                >
                  <span
                    className={
                      layout === "grid"
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
                  <span className={layout === "grid" ? "library-name" : "file-name"}>{entry.name}</span>
                  {layout === "list" && <span className="file-size">{formatBytes(entry.bytes, entry.kind)}</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {menu && (
        <div className="group-dialog focus-trap open">
          <button type="button" className="drawer-scrim" aria-label={text().close} tabIndex={-1} onClick={() => setMenu(null)} />
          <div className="group-dialog-panel group-create-panel file-menu" role="dialog" aria-label={menu.name}>
            <h2>{menuTargets.length > 1 ? text().files.selectedCount(menuTargets.length) : menu.name}</h2>
            <div className="library-tools file-menu-actions">
              {menuTargets.length === 1 && menu.kind === "file" && menu.editable ? (
                <button type="button" className="library-tool" data-focusable onClick={() => void edit(menu)}>
                  {text().edit}
                </button>
              ) : null}
              {menuTargets.length === 1 ? (
                <button type="button" className="library-tool" data-focusable onClick={() => activate(menu)}>
                  {text().open}
                </button>
              ) : null}
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  files.stageCopy(menuTargets);
                  setPicked([]);
                  setMenu(null);
                }}
              >
                {text().files.copy}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  files.stageMove(menuTargets);
                  setPicked([]);
                  setMenu(null);
                }}
              >
                {text().files.move}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  setTrash(menuTargets);
                  setMenu(null);
                }}
              >
                {text().delete}
              </button>
              {picked.length > 0 && (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    setPicked([]);
                    setMenu(null);
                  }}
                >
                  {text().files.clearSelection}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {naming && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => {
              setNaming(null);
              setDraft("");
            }}
          />
          <form
            className="group-dialog-panel group-create-panel"
            role="dialog"
            aria-label={naming === "dir" ? text().files.newFolder : text().files.newFile}
            onSubmit={(event) => {
              event.preventDefault();
              void submitName();
            }}
          >
            <h2>{naming === "dir" ? text().files.newFolder : text().files.newFile}</h2>
            <input
              ref={nameRef}
              className="group-name-input"
              data-focusable
              value={draft}
              placeholder={text().files.namePlaceholder}
              maxLength={120}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="group-empty">{text().files.createHint}</p>
            <div className="library-tools">
              <button ref={createRef} type="submit" className="library-tool" data-focusable>
                {text().create}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  setNaming(null);
                  setDraft("");
                }}
              >
                {text().cancel}
              </button>
            </div>
          </form>
        </div>
      )}
      {editor && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setEditor(null)}
          />
          <div className="group-dialog-panel file-editor-panel" role="dialog" aria-label={text().files.editTitle(editor.name)}>
            <h2>{editor.name}</h2>
            <textarea
              ref={editorRef}
              className="file-editor"
              data-focusable
              value={editor.text}
              onChange={(event) => {
                const pos = event.target.selectionStart ?? event.target.value.length;
                const text = event.target.value;
                setEditor((current) => (current ? { ...current, text } : current));
                requestAnimationFrame(() => editorRef.current?.setSelectionRange(pos, pos));
              }}
            />
            <p className="group-empty">{text().files.editorHint}</p>
            <div className="library-tools">
              <button
                ref={saveRef}
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  void files.writeText(editor.path, editor.text).then(() => setEditor(null)).catch((err: unknown) => {
                    files.setNote(typeof err === "string" ? err : text().files.saveFailed);
                  });
                }}
              >
                {text().save}
              </button>
              <button type="button" className="library-tool" data-focusable onClick={() => setEditor(null)}>
                {text().close}
              </button>
            </div>
          </div>
        </div>
      )}
      {trash && (
        <div className="group-dialog focus-trap open">
          <button type="button" className="drawer-scrim" aria-label={text().close} tabIndex={-1} onClick={() => setTrash(null)} />
          <div className="group-dialog-panel group-create-panel" role="dialog" aria-label={text().files.deleteTitle}>
            <h2>{trash.length === 1 ? text().files.deleteOne(trash[0].name) : text().files.deleteMany(trash.length)}</h2>
            <p className="group-empty">{text().files.deleteBody}</p>
            <div className="library-tools">
              <button ref={trashCancelRef} type="button" className="library-tool" data-focusable onClick={() => setTrash(null)}>
                {text().cancel}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  const targets = trash;
                  setTrash(null);
                  setPicked((current) => current.filter((path) => !targets.some((entry) => entry.path === path)));
                  void files.remove(targets);
                }}
              >
                {text().delete}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
