import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { FilePicker } from "../files/FilePicker";
import { setLibraryActions } from "../library/actions";
import { useLibraryGroups } from "../library/useLibraryGroups";
import { DEFAULT_MOD_HOOK, type ModStatus } from "../library/useLocalLibrary";
import type { PickedProgram } from "../library/useLocalLibrary";
import { useModProgress } from "../library/useModProgress";
import { text } from "../i18n";
import { playSfx } from "../audio/sfx";

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
  onHide: (id: string) => string;
  onQuit?: (id: string) => string | Promise<string>;
  runningIds?: Set<string>;
  restorable?: T[];
  onRestore?: (id: string) => string;
  onSteamCover?: (id: string, appId: string) => string | Promise<string>;
  /** Games only: install mods / tools (OptiScaler) for this game. */
  onInstallMods?: (id: string, hook: string) => string | Promise<string>;
  /** Games only: what's installed right now / can it be installed（点开菜单时问一次）。 */
  onModStatus?: (id: string, hook: string) => Promise<ModStatus | null>;
  /** Games only: uninstall OptiScaler and restore the overwritten files. */
  onUninstallMods?: (id: string) => string | Promise<string>;
  /** Games only: 打断正在下载的安装。 */
  onCancelMods?: () => void;
  onScan: () => void;
  scanning?: boolean;
  renderCard: (item: T, cardRef: Ref<HTMLButtonElement> | undefined, options?: CardOptions) => ReactNode;
};

export function LibraryShelf<T extends Item>({
  kind,
  items,
  note,
  status = "",
  label,
  onUseFile,
  onHide,
  onQuit,
  runningIds,
  restorable = [],
  onRestore,
  onSteamCover,
  onInstallMods,
  onModStatus,
  onUninstallMods,
  onCancelMods,
  onScan,
  scanning = false,
  renderCard,
}: Props<T>) {
  const library = useLibraryGroups(kind);
  const firstRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const focusAdd = useRef(false);
  const [naming, setNaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [hiding, setHiding] = useState<{ id: string; name: string } | null>(null);
  const [hint, setHint] = useState("");
  const [picking, setPicking] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuCardId, setMenuCardId] = useState<string | null>(null);
  const [menuView, setMenuView] = useState<MenuView>("actions");
  const [menuBox, setMenuBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const [fileTarget, setFileTarget] = useState<FileTarget | null>(null);
  const [coverFor, setCoverFor] = useState<{ id: string; name: string } | null>(null);
  const [coverDraft, setCoverDraft] = useState("");
  // OptiScaler 面板：先问一次状态（装哪儿 / 装了没有 / 会不会冲突），再让用户决定。
  const [modFor, setModFor] = useState<{ id: string; name: string } | null>(null);
  const [modState, setModState] = useState<ModStatus | null>(null);
  const [modLoading, setModLoading] = useState(false);
  const [modHook, setModHook] = useState(DEFAULT_MOD_HOOK);
  const [modBusy, setModBusy] = useState(false);
  const modProgress = useModProgress();
  const modRef = useRef<HTMLButtonElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const filePickRef = useRef(false);
  filePickRef.current = fileTarget !== null;
  const namingRef = useRef(naming);
  const deletingRef = useRef(deleting);
  const hidingRef = useRef(hiding);
  const pickingRef = useRef(picking);
  const restoringRef = useRef(restoring);
  const menuRef = useRef(menuCardId);
  const menuViewRef = useRef(menuView);
  const coverForRef = useRef(coverFor);
  const modForRef = useRef(modFor);
  namingRef.current = naming;
  deletingRef.current = deleting;
  hidingRef.current = hiding;
  pickingRef.current = picking;
  restoringRef.current = restoring;
  menuRef.current = menuCardId;
  menuViewRef.current = menuView;
  coverForRef.current = coverFor;
  modForRef.current = modFor;

  const visible =
    library.activeId === "all"
      ? items.filter((item) => !library.membership[item.id])
      : items.filter((item) => library.membership[item.id] === library.activeId);
  const visibleKey = visible.map((item) => item.id).join("\0");
  const activeName =
    library.groups.find((group) => group.id === library.activeId)?.name ?? text().library.all;
  const customGroup = library.activeId !== "all";
  const modPercent =
    modProgress && modProgress.totalBytes > 0
      ? Math.min(100, Math.round((modProgress.bytes / modProgress.totalBytes) * 100))
      : 0;
  const closeModPanel = () => {
    setModFor(null);
    setModState(null);
  };

  useEffect(() => {
    const blocked = () => document.querySelector(".drawer-root.open") !== null;
    setLibraryActions({
      cycleGroup: (dir) => {
        if (namingRef.current || deletingRef.current || hidingRef.current || pickingRef.current || restoringRef.current || menuRef.current || filePickRef.current || coverForRef.current || modForRef.current || blocked()) return;
        library.cycle(dir);
        playSfx("click");
      },
      openCardMenu: () => {
        if (namingRef.current || deletingRef.current || hidingRef.current || pickingRef.current || restoringRef.current || menuRef.current || filePickRef.current || coverForRef.current || modForRef.current || blocked()) return false;
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
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          const button = active.closest(".focus-trap, .card-menu")?.querySelector<HTMLElement>("button[data-focusable]");
          if (button) {
            button.focus();
            return true;
          }
        }
        if (modForRef.current) {
          // 安装/download 正在进行时只关面板：任务在 Rust 那边跑，进度条留在提示行。
          setModFor(null);
          setModState(null);
          return true;
        }
        if (coverForRef.current) {
          setCoverFor(null);
          setCoverDraft("");
          return true;
        }
        if (hidingRef.current) {
          setHiding(null);
          return true;
        }
        if (menuRef.current && (menuViewRef.current === "group" || menuViewRef.current === "rename")) {
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
        if (!namingRef.current && !deletingRef.current && !hidingRef.current && !pickingRef.current && !restoringRef.current) return false;
        setNaming(false);
        setDeleting(false);
        setHiding(null);
        setPicking(false);
        setRestoring(false);
        setDraft("");
        return true;
      },
    });
    return () => setLibraryActions({});
  }, [library]);

  useEffect(() => {
    if (naming || deleting || hiding || picking || restoring || menuCardId || fileTarget || coverFor || modFor) return;
    if (focusAdd.current && addRef.current) {
      addRef.current.focus();
      focusAdd.current = false;
      return;
    }
    const current = document.activeElement as HTMLElement | null;
    if (current?.closest("[data-focus-zone='library-tools'], [data-focus-zone='library-groups']")) return;
    const id = current?.closest("[data-card-id]")?.getAttribute("data-card-id");
    if (id && visible.some((item) => item.id === id)) return;
    if (firstRef.current) firstRef.current.focus();
    else addRef.current?.focus();
  }, [library.activeId, visibleKey, naming, deleting, hiding, picking, restoring, menuCardId, fileTarget, coverFor, modFor, visible]);

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);

  useEffect(() => {
    if (coverFor) coverRef.current?.focus();
  }, [coverFor]);

  useEffect(() => {
    if (modFor) modRef.current?.focus();
  }, [modFor, modLoading]);

  useEffect(() => {
    if (!deleting && !hiding) return;
    document.querySelector<HTMLElement>(".group-dialog [data-focusable]")?.focus();
  }, [deleting, hiding]);

  useEffect(() => {
    document.querySelector(".group-chip.is-current")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [library.activeId]);

  useEffect(() => {
    if (menuView === "rename") renameRef.current?.focus();
  }, [menuView, menuCardId]);

  useEffect(() => {
    if (!picking) return;
    document.querySelector<HTMLElement>(".picker-grid [data-focusable]")?.focus();
  }, [picking]);

  useEffect(() => {
    if (!restoring) return;
    document.querySelector<HTMLElement>(".picker-grid [data-focusable], .group-dialog [data-focusable]")?.focus();
  }, [restoring]);

  useLayoutEffect(() => {
    if (!menuCardId) {
      setMenuBox(null);
      return;
    }
    const card = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(menuCardId)}"]`);
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const menu = document.querySelector<HTMLElement>(".card-menu");
    const width = Math.max(rect.width, menu?.offsetWidth ?? rect.width);
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
    const top = Math.min(rect.top, window.innerHeight - 12 - (menu?.offsetHeight ?? 280));
    setMenuBox((current) => {
      const next = { top: Math.max(12, top), left, width: rect.width };
      if (current && current.top === next.top && current.left === next.left && current.width === next.width) return current;
      return next;
    });
  }, [menuCardId, menuView, menuBox == null]);

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
        <div className="library-group-row" data-focus-zone="library-groups" aria-live="polite">
        <div className="group-strip">
          <span className="group-switch-side">LT</span>
          <div className="group-strip-scroll" role="tablist" aria-label={text().library.groups}>
            <button
              type="button"
              role="tab"
              aria-selected={library.activeId === "all"}
              className={library.activeId === "all" ? "group-chip is-current" : "group-chip"}
              data-focusable
              onClick={() => {
                if (library.activeId === "all") return;
                playSfx("click");
                library.setActive("all");
              }}
            >
              {text().library.all}
            </button>
            {library.groups.map((group) => (
              <button
                key={group.id}
                type="button"
                role="tab"
                aria-selected={library.activeId === group.id}
                className={library.activeId === group.id ? "group-chip is-current" : "group-chip"}
                data-focusable
                onClick={() => {
                  if (library.activeId === group.id) return;
                  playSfx("click");
                  library.setActive(group.id);
                }}
              >
                {group.name}
              </button>
            ))}
          </div>
          <span className="group-switch-side">RT</span>
        </div>
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
            {text().library.newGroup}
          </button>
          {customGroup && (
            <button
              ref={addRef}
              type="button"
              className="library-tool"
              data-focusable
              onClick={() => setPicking(true)}
            >
              {text().library.addApps}
            </button>
          )}
          {customGroup && (
            <button
              type="button"
              className="library-tool"
              data-focusable
              onClick={() => setDeleting(true)}
            >
              {text().library.deleteGroup}
            </button>
          )}
          <button
            type="button"
            className="library-tool"
            data-focusable
            onClick={() => setFileTarget({ mode: "add" })}
          >
            {kind === "games" ? text().library.addGame : text().library.addApp}
          </button>
          {onRestore && (
            <button
              type="button"
              className="library-tool"
              data-focusable
              onClick={() => setRestoring(true)}
            >
              {text().library.addFromScan}
            </button>
          )}
          {!customGroup && (
            <button type="button" className="library-tool scan-action" data-focusable disabled={scanning} onClick={onScan}>
              {text().library.rescan}
            </button>
          )}
        </div>
        <p className="preview-note">{status || hint || note}</p>
      </div>
      {visible.length === 0 && items.length > 0 ? (
        <p className="group-empty">
          {customGroup
            ? text().library.noCards
            : text().library.ungrouped}
        </p>
      ) : visible.length === 0 ? null : (
        <section
          key={library.activeId}
          className="library-grid motion-stagger"
          data-focus-zone="library-grid"
          aria-label={label}
        >
          {visible.map((item, index) =>
            renderCard(item, index === 0 ? firstRef : undefined, {
              name: library.names[item.id] || item.name,
            }),
          )}
        </section>
      )}
      {hiding && (
        <div className="group-dialog focus-trap open">
          <button type="button" className="drawer-scrim" aria-label={text().close} tabIndex={-1} onClick={() => setHiding(null)} />
          <div className="group-dialog-panel group-create-panel" role="dialog" aria-label={kind === "games" ? text().library.hideGameTitle : text().library.hideAppTitle}>
            <h2>{text().library.hideHeading(kind === "games" ? text().tabs.games : text().tabs.apps, hiding.name)}</h2>
            <p className="group-empty">{text().library.hideBody}</p>
            <div className="library-tools">
              <button type="button" className="library-tool" data-focusable onClick={() => setHiding(null)}>
                {text().cancel}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  library.assignCard(hiding.id, null);
                  setHint(onHide(hiding.id));
                  setHiding(null);
                }}
              >
                {text().delete}
              </button>
            </div>
          </div>
        </div>
      )}
      {modFor && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={closeModPanel}
          />
          <div
            className="group-dialog-panel group-create-panel"
            role="dialog"
            aria-label={text().library.modsTitle(modFor.name)}
          >
            <h2>{text().library.modsTitle(modFor.name)}</h2>
            {modLoading && <p className="group-empty">{text().library.modsLoading}</p>}
            {!modLoading && (
              <>
                <p className="group-empty">
                  {modState?.dir ? text().library.modsDir(modState.dir) : text().library.modsNoDir}
                </p>
                <p className="group-empty">
                  {modState?.installed
                    ? modState.version
                      ? text().library.modsInstalled(modState.version, modState.hook ?? modHook)
                      : text().library.modsInstalledLegacy
                    : text().library.modsHookHint}
                </p>
                {!modState?.installed && (
                  <div className="library-tools">
                    {(modState?.hooks?.length ? modState.hooks : [DEFAULT_MOD_HOOK]).map((hook) => (
                      <button
                        key={hook}
                        type="button"
                        className={`library-tool${hook === modHook ? " is-current" : ""}`}
                        data-focusable
                        onClick={() => {
                          setModHook(hook);
                          if (!onModStatus) return;
                          const id = modFor.id;
                          setModLoading(true);
                          // 换注入名要重新问一次：同名文件是否被占用取决于选哪个名字。
                          void onModStatus(id, hook).then((state) => {
                            setModState(state);
                            setModLoading(false);
                          });
                        }}
                      >
                        {hook}
                      </button>
                    ))}
                  </div>
                )}
                {modState?.arch && (
                  <p className="group-empty">{text().library.modsArch(modState.arch)}</p>
                )}
                {modState?.running && <p className="group-empty">{text().library.modsRunning}</p>}
                {modState?.conflict && (
                  <p className="group-empty">{text().library.modsConflict(modState.conflict)}</p>
                )}
                <p className="group-empty">{text().library.modsWarn}</p>
              </>
            )}
            {modBusy && (
              <p className="group-empty">
                {modProgress?.phase === "download"
                  ? text().library.modsProgress(modPercent)
                  : modProgress?.phase === "extract"
                    ? text().library.modsExtracting
                    : modProgress?.phase === "copy"
                      ? text().library.modsWriting
                      : text().library.installModsBusy}
              </p>
            )}
            <div className="library-tools">
              <button type="button" className="library-tool" data-focusable onClick={closeModPanel}>
                {text().library.modsClose}
              </button>
              {modBusy ? (
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => onCancelMods?.()}
                >
                  {text().library.modsCancel}
                </button>
              ) : (
                <>
                  {modState?.installed && onUninstallMods && (
                    <button
                      type="button"
                      className="library-tool"
                      data-focusable
                      onClick={() => {
                        const id = modFor.id;
                        setModBusy(true);
                        void Promise.resolve(onUninstallMods(id)).then((message) => {
                          setHint(message);
                          setModBusy(false);
                          if (onModStatus) void onModStatus(id, modHook).then(setModState);
                        });
                      }}
                    >
                      {text().library.modsUninstall}
                    </button>
                  )}
                  {onInstallMods && (
                    <button
                      ref={modRef}
                      type="button"
                      className="library-tool"
                      data-focusable
                      onClick={() => {
                        const id = modFor.id;
                        setModBusy(true);
                        void Promise.resolve(onInstallMods(id, modHook)).then((message) => {
                          setHint(message);
                          setModBusy(false);
                          if (onModStatus) void onModStatus(id, modHook).then(setModState);
                        });
                      }}
                    >
                      {modState?.installed ? text().library.modsReinstall : text().library.modsInstall}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {deleting && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setDeleting(false)}
          />
          <div className="group-dialog-panel group-create-panel" role="dialog" aria-label={text().library.deleteGroupTitle}>
            <h2>{text().library.deleteGroupHeading(activeName)}</h2>
            <p className="group-empty">{text().library.deleteGroupBody}</p>
            <div className="library-tools">
              <button type="button" className="library-tool" data-focusable onClick={() => setDeleting(false)}>
                {text().cancel}
              </button>
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  library.deleteGroup(library.activeId);
                  setDeleting(false);
                }}
              >
                {text().delete}
              </button>
            </div>
          </div>
        </div>
      )}
      {coverFor && onSteamCover && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => {
              setCoverFor(null);
              setCoverDraft("");
            }}
          />
          <form
            className="group-dialog-panel group-create-panel"
            role="dialog"
            aria-label={text().library.steamTitle}
            onSubmit={(event) => {
              event.preventDefault();
              const target = coverFor;
              const digits = coverDraft.trim();
              setCoverFor(null);
              setCoverDraft("");
              void Promise.resolve(onSteamCover(target.id, digits)).then((message) => {
                if (message) setHint(message);
              });
            }}
          >
            <h2>{text().library.steamHeading(coverFor.name)}</h2>
            <input
              ref={coverRef}
              className="group-name-input"
              data-focusable
              value={coverDraft}
              placeholder={text().library.steamPlaceholder}
              inputMode="numeric"
              maxLength={10}
              onChange={(event) => setCoverDraft(event.target.value.replace(/\D/g, ""))}
            />
            <p className="group-empty">{text().library.steamBody}</p>
            <div className="library-tools">
              <button
                type="button"
                className="library-tool"
                data-focusable
                onClick={() => {
                  setCoverFor(null);
                  setCoverDraft("");
                }}
              >
                {text().cancel}
              </button>
              <button type="submit" className="library-tool" data-focusable>
                {text().library.fetchCover}
              </button>
            </div>
          </form>
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
              setNaming(false);
              setDraft("");
              createRef.current?.focus();
            }}
          />
          <form
            className="group-dialog-panel group-create-panel"
            role="dialog"
            aria-label={text().library.newGroupTitle}
            onSubmit={(event) => {
              event.preventDefault();
              createGroup();
            }}
          >
            <h2>{text().library.newGroupTitle}</h2>
            <input
              ref={nameRef}
              className="group-name-input"
              data-focusable
              value={draft}
              placeholder={text().library.groupPlaceholder}
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
                {text().cancel}
              </button>
              <button type="submit" className="library-tool" data-focusable>
                {text().create}
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
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => {
              setMenuCardId(null);
              setMenuView("actions");
            }}
          />
          <div
            className="card-menu"
            role="menu"
            style={{ top: menuBox.top, left: menuBox.left, minWidth: menuBox.width }}
          >
            {menuView === "actions" && (
              <>
                {kind === "games" && onQuit && menuCardId && runningIds?.has(menuCardId) && (
                  <button
                    type="button"
                    className="library-tool"
                    data-focusable
                    onClick={() => {
                      if (!menuCardId) return;
                      const id = menuCardId;
                      setMenuCardId(null);
                      setMenuView("actions");
                      void Promise.resolve(onQuit(id)).then(setHint);
                    }}
                  >
                    {text().library.quitGame}
                  </button>
                )}
                <button type="button" className="library-tool" data-focusable onClick={() => setMenuView("group")}>
                  {text().library.setGroup}
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
                  {text().library.rename}
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
                  {text().library.changePath}
                </button>
                {kind === "games" && onSteamCover && (
                  <button
                    type="button"
                    className="library-tool"
                    data-focusable
                    onClick={() => {
                      const item = items.find((entry) => entry.id === menuCardId);
                      if (!menuCardId || !item) return;
                      setCoverDraft("");
                      setCoverFor({ id: menuCardId, name: library.names[menuCardId] || item.name });
                      setMenuCardId(null);
                      setMenuView("actions");
                    }}
                  >
                    {text().library.steamMenu}
                  </button>
                )}
                {kind === "games" && onInstallMods && (
                  <button
                    type="button"
                    className="library-tool"
                    data-focusable
                    onClick={() => {
                      if (!menuCardId) return;
                      const id = menuCardId;
                      const item = items.find((entry) => entry.id === id);
                      setMenuCardId(null);
                      setMenuView("actions");
                      setModFor({ id, name: item ? library.names[id] || item.name : id });
                      setModState(null);
                      setModHook(DEFAULT_MOD_HOOK);
                      // 先问状态：装哪儿、装了没有、会不会冲突 —— 让用户带着事实决定，
                      // 而不是点一下才发现装到了别的目录（老实现就是闷着装的）。
                      if (onModStatus) {
                        setModLoading(true);
                        void onModStatus(id, DEFAULT_MOD_HOOK).then((state) => {
                          setModState(state);
                          setModLoading(false);
                        });
                      }
                    }}
                  >
                    {text().library.installMods}
                  </button>
                )}
                <button
                  type="button"
                  className="library-tool"
                  data-focusable
                  onClick={() => {
                    const item = items.find((entry) => entry.id === menuCardId);
                    if (!menuCardId || !item) return;
                    setHiding({ id: menuCardId, name: library.names[menuCardId] || item.name });
                    setMenuCardId(null);
                    setMenuView("actions");
                  }}
                >
                  {text().library.remove}
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
                    {text().library.leaveGroup}
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
                    {library.membership[menuCardId] === group.id ? text().library.currentGroup : ""}
                  </button>
                ))}
                {library.groups.length === 0 && <p className="group-empty">{text().library.noGroups}</p>}
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
                  data-focusable
                  value={draft}
                  maxLength={24}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="library-tool" data-focusable>
                  {text().save}
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
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setPicking(false)}
          />
          <div className="group-dialog-panel picker-panel" role="dialog" aria-label={text().library.addCards}>
            <div className="picker-title">
              <h2>{text().library.addTo(activeName)}</h2>
              <p>{text().library.pickerHint}</p>
            </div>
            <section className="library-grid picker-grid" aria-label={text().library.currentLibrary}>
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
      {restoring && onRestore && (
        <div className="group-dialog focus-trap open">
          <button
            type="button"
            className="drawer-scrim"
            aria-label={text().close}
            tabIndex={-1}
            onClick={() => setRestoring(false)}
          />
          <div className="group-dialog-panel picker-panel" role="dialog" aria-label={text().library.addFromScan}>
            <div className="picker-title">
              <h2>{text().library.addFromScan}</h2>
              <p>{text().library.restoreHint}</p>
            </div>
            {restorable.length === 0 ? (
              <p className="group-empty">{text().library.restoreEmpty}</p>
            ) : (
              <section className="library-grid picker-grid" aria-label={text().library.addFromScan}>
                {restorable.map((item) =>
                  renderCard(item, undefined, {
                    name: library.names[item.id] || item.name,
                    onPick: () => {
                      setHint(onRestore(item.id));
                    },
                  }),
                )}
              </section>
            )}
            {restorable.length === 0 && (
              <div className="library-tools">
                <button type="button" className="library-tool" data-focusable onClick={() => setRestoring(false)}>
                  {text().close}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {fileTarget && (
        <FilePicker
          title={fileTarget.mode === "add" ? (kind === "games" ? text().library.addGame : text().library.addApp) : text().library.changePath}
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
