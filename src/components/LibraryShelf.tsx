import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { FilePicker } from "../files/FilePicker";
import { setLibraryActions } from "../library/actions";
import { useLibraryGroups } from "../library/useLibraryGroups";
import type { PickedProgram } from "../library/useLocalLibrary";

type Item = { id: string; name: string };

type CardOptions = {
  picked?: boolean;
  onPick?: () => void;
  name?: string;
};

type MenuView = "actions" | "group" | "rename";

type FileTarget = { mode: "add" } | { mode: "path"; id: string };

type Props<T extends Item> = {
  kind: "games" | "apps";
  items: T[];
  note: string;
  status?: string;
  label: string;
  onUseFile: (target: FileTarget, file: PickedProgram) => string;
  renderCard: (item: T, cardRef: Ref<HTMLButtonElement> | undefined, options?: CardOptions) => ReactNode;
};

export function LibraryShelf<T extends Item>({ kind, items, note, status = "", label, onUseFile, renderCard }: Props<T>) {
  const library = useLibraryGroups(kind);
  const firstRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const focusAdd = useRef(false);
  const [naming, setNaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [hint, setHint] = useState("");
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuCardId, setMenuCardId] = useState<string | null>(null);
  const [menuView, setMenuView] = useState<MenuView>("actions");
  const [menuBox, setMenuBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const [fileTarget, setFileTarget] = useState<FileTarget | null>(null);
  const filePickRef = useRef(false);
  filePickRef.current = fileTarget !== null;
  const namingRef = useRef(naming);
  const deletingRef = useRef(deleting);
  const pickingRef = useRef(picking);
  const menuRef = useRef(menuCardId);
  const menuViewRef = useRef(menuView);
  namingRef.current = naming;
  deletingRef.current = deleting;
  pickingRef.current = picking;
  menuRef.current = menuCardId;
  menuViewRef.current = menuView;

  const visible =
    library.activeId === "all"
      ? items
      : items.filter((item) => library.membership[item.id] === library.activeId);
  const visibleKey = visible.map((item) => item.id).join("\0");
  const activeName =
    library.groups.find((group) => group.id === library.activeId)?.name ?? "全部";
  const customGroup = library.activeId !== "all";

  useEffect(() => {
    const blocked = () => document.querySelector(".drawer-root.open") !== null;
    setLibraryActions({
      cycleGroup: (dir) => {
        if (namingRef.current || deletingRef.current || pickingRef.current || menuRef.current || filePickRef.current || blocked()) return;
        library.cycle(dir);
      },
      openCardMenu: () => {
        if (namingRef.current || deletingRef.current || pickingRef.current || menuRef.current || filePickRef.current || blocked()) return false;
        const cardId = (document.activeElement as HTMLElement | null)
          ?.closest("[data-card-id]")
          ?.getAttribute("data-card-id");
        if (!cardId) return false;
        setMenuView("actions");
        setMenuCardId(cardId);
        return true;
      },
      closeDialog: () => {
        if (filePickRef.current) return false;
        if (menuViewRef.current === "group" || menuViewRef.current === "rename") {
          setMenuView("actions");
          setDraft("");
          return true;
        }
        if (menuRef.current) {
          const cardId = menuRef.current;
          setMenuCardId(null);
          setMenuView("actions");
          window.setTimeout(() => {
            document
              .querySelector<HTMLElement>(`[data-card-id="${CSS.escape(cardId)}"]`)
              ?.focus();
          }, 0);
          return true;
        }
        if (!namingRef.current && !deletingRef.current && !pickingRef.current) return false;
        setNaming(false);
        setDeleting(false);
        setPicking(false);
        setDraft("");
        return true;
      },
    });
    return () => setLibraryActions({});
  }, [library]);

  useEffect(() => {
    if (naming || deleting || picking || menuCardId || fileTarget) return;
    if (focusAdd.current && addRef.current) {
      addRef.current.focus();
      focusAdd.current = false;
      return;
    }
    const current = document.activeElement as HTMLElement | null;
    if (current?.closest("[data-focus-zone='library-tools']")) return;
    const id = current?.closest("[data-card-id]")?.getAttribute("data-card-id");
    if (id && visible.some((item) => item.id === id)) return;
    if (firstRef.current) firstRef.current.focus();
    else addRef.current?.focus();
  }, [library.activeId, visibleKey, naming, deleting, picking, menuCardId, fileTarget, visible]);

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);

  useEffect(() => {
    if (!deleting) return;
    document.querySelector<HTMLElement>(".group-dialog [data-focusable]")?.focus();
  }, [deleting]);

  useEffect(() => {
    if (menuView === "rename") renameRef.current?.focus();
  }, [menuView, menuCardId]);

  useEffect(() => {
    if (!picking) return;
    document.querySelector<HTMLElement>(".picker-grid [data-focusable]")?.focus();
  }, [picking]);

  useLayoutEffect(() => {
    if (!menuCardId) {
      setMenuBox(null);
      return;
    }
    const card = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(menuCardId)}"]`);
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const width = Math.max(rect.width, 168);
    const left = Math.min(rect.left, window.innerWidth - width - 12);
    const top = Math.min(rect.top, window.innerHeight - 210);
    setMenuBox({ top: Math.max(12, top), left: Math.max(12, left), width });
  }, [menuCardId, menuView]);

  useEffect(() => {
    if (!menuCardId || menuView === "rename") return;
    document.querySelector<HTMLElement>(".card-menu [data-focusable]")?.focus();
  }, [menuCardId, menuView]);

  const createGroup = () => {
    const id = library.createGroup(draft);
    if (!id) return;
    setDraft("");
    setNaming(false);
    focusAdd.current = true;
  };

  const toggleCard = (cardId: string) => {
    if (library.membership[cardId] === library.activeId) library.assignCard(cardId, null);
    else library.assignCard(cardId, library.activeId);
  };

  return (
    <main className="page library-page">
      <div className="library-head">
        <div className="group-switch" aria-live="polite">
          <span className="group-switch-side">LT</span>
          <strong className="group-switch-name">{activeName}</strong>
          <span className="group-switch-side">RT</span>
        </div>
        <div className="library-tools" data-focus-zone="library-tools">
          <button
            ref={createRef}
            type="button"
            className="library-tool"
            data-focusable
            onClick={() => {
              setDraft("");
              setNaming(true);
            }}
          >
            新建分组
          </button>
          <button
            type="button"
            className="library-tool"
            data-focusable
            onClick={() => setFileTarget({ mode: "add" })}
          >
            {kind === "games" ? "添加游戏" : "添加软件"}
          </button>
          {customGroup && (
            <button
              ref={addRef}
              type="button"
              className="library-tool"
              data-focusable
              onClick={() => setPicking(true)}
            >
              添加卡片
            </button>
          )}
          {customGroup && (
            <button
              type="button"
              className="library-tool"
              data-focusable
              onClick={() => setDeleting(true)}
            >
              删除分组
            </button>
          )}
        </div>
        <p className="preview-note">{status || hint || note}</p>
      </div>
      {visible.length === 0 && items.length > 0 ? (
        <p className="group-empty">此分组还没有卡片。用方向键选中「添加卡片」，按 A 从当前库加入。</p>
      ) : visible.length === 0 ? null : (
        <section className="library-grid" data-focus-zone="library-grid" aria-label={label}>
          {visible.map((item, index) =>
            renderCard(item, index === 0 ? firstRef : undefined, {
              name: library.names[item.id] || item.name,
            }),
          )}
        </section>
      )}
      {deleting && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label="关闭"
            tabIndex={-1}
            onClick={() => setDeleting(false)}
          />
          <div className="group-dialog-panel group-create-panel" role="dialog" aria-label="删除分组">
            <h2>删除分组「{activeName}」？</h2>
            <p className="group-empty">分组里的卡片会回到「全部」，不会从库里删掉。</p>
            <div className="library-tools">
              <button type="button" className="library-tool" data-focusable onClick={() => setDeleting(false)}>
                取消
              </button>
              <button
                type="button"
                className="library-tool library-tool-solid"
                data-focusable
                onClick={() => {
                  library.deleteGroup(library.activeId);
                  setDeleting(false);
                }}
              >
                删除
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
              setNaming(false);
              setDraft("");
              createRef.current?.focus();
            }}
          />
          <form
            className="group-dialog-panel group-create-panel"
            role="dialog"
            aria-label="新建分组"
            onSubmit={(event) => {
              event.preventDefault();
              createGroup();
            }}
          >
            <h2>新建分组</h2>
            <input
              ref={nameRef}
              className="group-name-input"
              value={draft}
              placeholder="分组名称"
              maxLength={16}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="library-tools">
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  setNaming(false);
                  setDraft("");
                  createRef.current?.focus();
                }}
              >
                取消
              </button>
              <button type="submit" className="library-tool library-tool-solid" data-focusable>
                创建
              </button>
            </div>
          </form>
        </div>
      )}
      {menuCardId && menuBox && (
        <div className="card-menu-layer focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label="关闭"
            tabIndex={-1}
            onClick={() => {
              setMenuCardId(null);
              setMenuView("actions");
            }}
          />
          <div
            className="card-menu"
            role="menu"
            style={{ top: menuBox.top, left: menuBox.left, width: menuBox.width }}
          >
            {menuView === "actions" && (
              <>
                <button type="button" className="library-tool" data-focusable onClick={() => setMenuView("group")}>
                  设置分组
                </button>
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    const item = items.find((entry) => entry.id === menuCardId);
                    setDraft(library.names[menuCardId] || item?.name || "");
                    setMenuView("rename");
                  }}
                >
                  修改名称
                </button>
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    if (!menuCardId) return;
                    setFileTarget({ mode: "path", id: menuCardId });
                    setMenuCardId(null);
                    setMenuView("actions");
                  }}
                >
                  修改路径
                </button>
              </>
            )}
            {menuView === "group" && (
              <>
                {library.membership[menuCardId] && (
                  <button
                    type="button"
                    className="library-tool"
                    data-focusable
                    onClick={() => {
                      library.assignCard(menuCardId, null);
                      setMenuCardId(null);
                    }}
                  >
                    移出分组
                  </button>
                )}
                {library.groups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className="library-tool"
                    data-focusable
                    onClick={() => {
                      library.assignCard(menuCardId, group.id);
                      setMenuCardId(null);
                    }}
                  >
                    {group.name}
                    {library.membership[menuCardId] === group.id ? " · 当前" : ""}
                  </button>
                ))}
                {library.groups.length === 0 && <p className="group-empty">还没有分组，请先新建。</p>}
              </>
            )}
            {menuView === "rename" && (
              <form
                className="card-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  const item = items.find((entry) => entry.id === menuCardId);
                  const trimmed = draft.trim();
                  library.setName(menuCardId, !trimmed || trimmed === item?.name ? null : trimmed);
                  setMenuCardId(null);
                  setDraft("");
                }}
              >
                <input
                  ref={renameRef}
                  className="group-name-input"
                  value={draft}
                  maxLength={24}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="library-tool library-tool-solid" data-focusable>
                  保存
                </button>
              </form>
            )}
          </div>
        </div>
      )}
      {picking && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label="关闭"
            tabIndex={-1}
            onClick={() => setPicking(false)}
          />
          <div className="group-dialog-panel picker-panel" role="dialog" aria-label="添加卡片">
            <div className="picker-title">
              <h2>添加到「{activeName}」</h2>
              <p>方向键选择，A 添加或移除，B 返回</p>
            </div>
            <section className="library-grid picker-grid" aria-label="当前库">
              {items.map((item) =>
                renderCard(item, undefined, {
                  name: library.names[item.id] || item.name,
                  picked: library.membership[item.id] === library.activeId,
                  onPick: () => toggleCard(item.id),
                }),
              )}
            </section>
          </div>
        </div>
      )}
      {fileTarget && (
        <FilePicker
          title={fileTarget.mode === "add" ? (kind === "games" ? "添加游戏" : "添加软件") : "修改路径"}
          onClose={() => setFileTarget(null)}
          onPick={(file) => {
            setHint(onUseFile(fileTarget, file));
            setFileTarget(null);
          }}
        />
      )}
    </main>
  );
}
