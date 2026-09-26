import { useEffect, useRef, useState } from "react";
import { setFileActions } from "../files/actions";
import { useFileBrowser, type FileEntry } from "../files/useFileBrowser";

type Naming = "dir" | "file" | null;
type EditorState = { path: string; name: string; text: string };

function formatBytes(bytes: number, kind: string) {
  if (kind === "dir") return "文件夹";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FilesPage() {
  const files = useFileBrowser();
  const [naming, setNaming] = useState<Naming>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<FileEntry | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const overlay = useRef({ menu: false, naming: false, editor: false });
  const listRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const newFolderRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  overlay.current = { menu: menu !== null, naming: naming !== null, editor: editor !== null };

  useEffect(() => {
    setFileActions({
      blocksTabs: () => overlay.current.menu || overlay.current.naming || overlay.current.editor,
      dismiss: () => {
        setMenu(null);
        setNaming(null);
        setEditor(null);
        setDraft("");
      },
      openMenu: () => {
        if (overlay.current.menu || overlay.current.naming || overlay.current.editor) return false;
        const name = (document.activeElement as HTMLElement | null)
          ?.closest("[data-file-name]")
          ?.getAttribute("data-file-name");
        const entry = files.entries.find((item) => item.name === name);
        if (!entry) return false;
        setMenu(entry);
        return true;
      },
      back: () => {
        const active = document.activeElement;
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
    if (active?.closest("[data-focus-zone='files-tools'], [data-focus-zone='files-list']")) return;
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
      files.setNote(typeof err === "string" ? err : "无法新建");
    }
  }

  async function edit(entry: FileEntry) {
    try {
      const text = await files.readText(entry);
      setMenu(null);
      setEditor({ path: entry.path, name: entry.name, text });
    } catch (err) {
      setMenu(null);
      files.setNote(typeof err === "string" ? err : "无法编辑");
    }
  }

  function activate(entry: FileEntry) {
    setMenu(null);
    if (entry.kind === "dir") {
      files.enter(entry);
      return;
    }
    if (entry.editable) {
      void edit(entry);
      return;
    }
    void files.openExternal(entry).catch((err: unknown) => {
      files.setNote(typeof err === "string" ? err : "无法打开");
    });
  }

  const hint =
    files.note ||
    (files.preview
      ? "浏览器预览不会写入磁盘。A 打开，B 返回，Y 对当前项操作。"
      : "A 打开，B 返回，Y 对当前项复制、移动或编辑。");

  return (
    <main className="page library-page">
      <div className="library-head">
        <div className="group-switch" aria-live="polite">
          <span className="group-switch-side">B</span>
          <strong className="group-switch-name">{files.title}</strong>
          <span className="group-switch-side">{files.location == null ? "盘" : "返回"}</span>
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
            新建文件夹
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
            新建文件
          </button>
          <button
            type="button"
            className="library-tool"
            data-focusable
            disabled={files.clip == null || files.location == null}
            onClick={() => void files.paste()}
          >
            粘贴
          </button>
          {files.location != null && (
            <button type="button" className="library-tool" data-focusable onClick={() => files.up()}>
              返回上一级
            </button>
          )}
        </div>
        <p className="preview-note">{files.pathLabel}</p>
        <p className="preview-note">{hint}</p>
      </div>
      {files.entries.length === 0 ? (
        <p className="group-empty">这个文件夹是空的。用上方按钮新建，或先复制一项再粘贴。</p>
      ) : (
        <div className="file-list" data-focus-zone="files-list" ref={listRef}>
          {files.entries.map((entry, index) => (
            <button
              key={entry.path}
              ref={index === 0 ? firstRef : undefined}
              type="button"
              className="file-row"
              data-focusable
              data-file-name={entry.name}
              onClick={() => activate(entry)}
            >
              <span className={entry.kind === "dir" ? "file-mark is-dir" : "file-mark"} aria-hidden>
                {entry.kind === "dir" ? "夹" : "文"}
              </span>
              <span className="file-name">{entry.name}</span>
              <span className="file-size">{formatBytes(entry.bytes, entry.kind)}</span>
            </button>
          ))}
        </div>
      )}
      {menu && (
        <div className="group-dialog focus-trap open">
          <button type="button" className="drawer-scrim" aria-label="关闭" tabIndex={-1} onClick={() => setMenu(null)} />
          <div className="group-dialog-panel group-create-panel file-menu" role="dialog" aria-label={menu.name}>
            <h2>{menu.name}</h2>
            <div className="library-tools file-menu-actions">
              {menu.kind === "file" && menu.editable ? (
                <>
                  <button type="button" className="library-tool" data-focusable onClick={() => void edit(menu)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="library-tool"
                    data-focusable
                    onClick={() => {
                      setMenu(null);
                      void files.openExternal(menu);
                    }}
                  >
                    用系统打开
                  </button>
                </>
              ) : (
                <button type="button" className="library-tool" data-focusable onClick={() => activate(menu)}>
                  打开
                </button>
              )}
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  files.stageCopy(menu);
                  setMenu(null);
                }}
              >
                复制
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  files.stageMove(menu);
                  setMenu(null);
                }}
              >
                移动
              </button>
            </div>
          </div>
        </div>
      )}
      {naming && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label="关闭"
            tabIndex={-1}
            onClick={() => {
              setNaming(null);
              setDraft("");
            }}
          />
          <form
            className="group-dialog-panel group-create-panel"
            role="dialog"
            aria-label={naming === "dir" ? "新建文件夹" : "新建文件"}
            onSubmit={(event) => {
              event.preventDefault();
              void submitName();
            }}
          >
            <h2>{naming === "dir" ? "新建文件夹" : "新建文件"}</h2>
            <input
              ref={nameRef}
              className="group-name-input"
              value={draft}
              placeholder="名称"
              maxLength={120}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p className="group-empty">A 创建。B 先回到创建，再按 B 取消。</p>
            <div className="library-tools">
              <button ref={createRef} type="submit" className="library-tool library-tool-solid" data-focusable>
                创建
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
                取消
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
            aria-label="关闭"
            tabIndex={-1}
            onClick={() => setEditor(null)}
          />
          <div className="group-dialog-panel file-editor-panel" role="dialog" aria-label={`编辑 ${editor.name}`}>
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
            <p className="group-empty">方向键移动光标，A 换行。B 回到保存，再按 B 放弃修改。</p>
            <div className="library-tools">
              <button
                ref={saveRef}
                type="button"
                className="library-tool library-tool-solid"
                data-focusable
                onClick={() => {
                  void files.writeText(editor.path, editor.text).then(() => setEditor(null)).catch((err: unknown) => {
                    files.setNote(typeof err === "string" ? err : "无法保存");
                  });
                }}
              >
                保存
              </button>
              <button type="button" className="library-tool" data-focusable onClick={() => setEditor(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
