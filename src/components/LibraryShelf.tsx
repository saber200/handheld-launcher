import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { SearchIcon } from "./NavIcons";
import { FilePicker } from "../files/FilePicker";
import { showSoftKeyboard } from "../files/useFileBrowser";
import { setLibraryActions } from "../library/actions";
import { useLibraryGroups } from "../library/useLibraryGroups";
import { DEFAULT_MOD_HOOK, type ModStatus, type ModVersion } from "../library/useLocalLibrary";
import type { PickedProgram } from "../library/useLocalLibrary";
import { useModProgress } from "../library/useModProgress";
import { text } from "../i18n";
import { playSfx } from "../audio/sfx";

type Item = { id: string; name: string };

export type CardOptions = {
  picked?: boolean;
  onPick?: () => void;
  name?: string;
  /**
   * 这张卡画在哪儿：`"shelf"` = K1 的横向卡片条（只有聚焦的那张放大、露第二行），
   * `"grid"` = K2 软件库的页面网格（画板 §4.1 的四段卡片），
   * `"picker"` = 「添加卡片 / 从扫描添加」对话框里的网格 —— 那个沿用旧卡片样式，
   * 不然对话框里会跟着页面卡的尺寸一起变形。
   */
  variant?: "shelf" | "grid" | "picker";
  /** 这张卡是不是当前聚焦的那张（画板：只有聚焦卡露「时长 · 体积」第二行）。 */
  focused?: boolean;
  /** 这张卡对应的程序正在运行（K2 的包头行写「运行中」而不是「已安装」）。 */
  running?: boolean;
};

type MenuView = "actions" | "group" | "rename";

type FileTarget = { mode: "add" } | { mode: "path"; id: string };

/** 系统设了「减少动态效果」时，居中直接跳过去，不做平滑滚动。 */
function reduceMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * hero 交叉淡入：聚焦项一换就换图，旧图留 160ms 慢慢淡掉（时长与 CSS 里
 * `.k1-hero-layer.is-leaving` 的动画对齐，改一个就得改另一个）。
 *
 * 依赖里的 item 是库数组里的同一个对象；库重建后对象会变新，但 id 没变就什么都不做 ——
 * 只是重新排序不该重放一次换图动画。
 */
function useHeroCrossFade<T extends Item>(item: T | undefined): T | null {
  const [leaving, setLeaving] = useState<T | null>(null);
  const previous = useRef<T | null>(null);
  const id = item?.id ?? null;
  useEffect(() => {
    const last = previous.current;
    previous.current = item ?? null;
    if (!last || !item || last.id === item.id) return;
    setLeaving(last);
    const timer = window.setTimeout(() => setLeaving(null), 160);
    return () => window.clearTimeout(timer);
  }, [id, item]);
  return leaving;
}

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
  onInstallMods?: (id: string, hook: string, version?: string) => string | Promise<string>;
  /** Games only: what's installed right now / can it be installed（点开菜单时问一次）。 */
  onModStatus?: (id: string, hook: string) => Promise<ModStatus | null>;
  /** Games only: 能装的版本列表（拿不到就空数组，按「装最新」走）。 */
  onModVersions?: () => Promise<ModVersion[]>;
  /** Games only: uninstall OptiScaler and restore the overwritten files. */
  onUninstallMods?: (id: string) => string | Promise<string>;
  /** Games only: 打断正在下载的安装。 */
  onCancelMods?: () => void;
  onScan: () => void;
  scanning?: boolean;
  /**
   * 布局。`"shelf"` = 画板 K1 的横向卡片条（游戏库用）；`"grid"`（默认）= 旧网格 ——
   * 软件库要到 M2 才换 K2，在它换掉之前这条老路径**一行都不动**。
   */
  layout?: "grid" | "shelf";
  /**
   * 皮肤。`"k2"` = 画板 K2 的软件库（6 列卡片网格 + 底部操作条）。视觉与 K1 同源
   * （同一套令牌、同样的头部结构），但内容区形状完全不同，所以页面侧单独给一份
   * `apps.css`；不传就按 `layout` 走（shelf → K1，其余 → 旧样式，等 M3 收）。
   */
  skin?: "k2";
  /** 卡片条上方的页面标题（画板里是 23dp 粗体）。不传就没有标题行。 */
  heading?: string;
  /**
   * 卡片条顶部的大图。**图从哪来由页面定**（宽图 → 封面 → 程序化占位是页面的回退链），
   * 这里只负责换图时的交叉淡入与压暗遮罩。
   */
  renderHero?: (item: T) => ReactNode;
  /** 信息面板内容（聚焦项的名称 / 元信息 / 数据格）。ctx.name 是改名后的名字。 */
  renderInfo?: (item: T, ctx: { name: string }) => ReactNode;
  /** 操作区（主按钮 + 状态行）。ctx.status 是页面自己的提示（扫描说明 / 操作结果）。 */
  renderActions?: (item: T, ctx: { name: string; status: string }) => ReactNode;
  /**
   * K2 底部那条：聚焦卡片的信息 + 右侧动作（画板上是「安装」+「打开目录」+ 目录图标）。
   * 页面侧给（软件库才知道怎么启动 / 打开目录），这里只负责「聚焦项一变就跟着变」，
   * 和 K1 的 `renderActions` 同一个思路。不传就退化成原来的「重新扫描 / 添加软件」。
   */
  renderBar?: (item: T | null, ctx: { name: string; status: string }) => ReactNode;
  /** K2 头部右上那颗搜索框里的占位文字。传了才渲染搜索（游戏库还用不上）。 */
  searchPlaceholder?: string;
  /** 标题右边那句小结（画板 K2：「12 个已装软件」）。 */
  headingNote?: string;
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
  onModVersions,
  onUninstallMods,
  onCancelMods,
  onScan,
  scanning = false,
  layout = "grid",
  skin,
  heading,
  renderHero,
  renderInfo,
  renderActions,
  renderBar,
  searchPlaceholder,
  headingNote,
  renderCard,
}: Props<T>) {
  const library = useLibraryGroups(kind);
  const shelf = layout === "shelf";
  // K2 = 画板那份软件库：头部与 K1 同构，内容区换成 6 列卡片网格 + 底部操作条。
  const k2 = skin === "k2";
  const stripRef = useRef<HTMLElement>(null);
  /**
   * 头部那颗搜索框（画板 K2 右上，365×32）。
   *
   * 为什么默认是一颗**按钮**、按下去才变成输入框：掌机上手柄打字是件苦差事，
   * 系统软键盘又要用户先点一下输入框才出来。做成「按钮 → 输入框 + 叫系统键盘」
   * 这一步，手柄用户也走得通（文件页的「搜索」就是同一个路子）。
   * `query` 一直留着：收起输入框不等于清掉关键词，用户可能只是要腾地方看卡片。
   */
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // 卡片条里「当前聚焦」的是哪一张：hero 换图、信息面板、操作按钮都跟着它走。
  const [focusId, setFocusId] = useState<string | null>(null);
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
  const [modVersions, setModVersions] = useState<ModVersion[]>([]);
  // null = 装最新（默认）。选老版本时才带上 tag。
  const [modTag, setModTag] = useState<string | null>(null);
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
  /**
   * 关键词过滤（画板 K2 右上那颗搜索框）。
   *
   * 只按**名字**匹配，不搜路径 / 描述：用户输入的是「微信」这种名字，
   * 搜路径会搜出「D:\Program Files\...」的一堆无关命中，反而更难找。
   */
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? visible.filter((item) => (library.names[item.id] || item.name).toLowerCase().includes(needle))
    : visible;
  const visibleKey = visible.map((item) => item.id).join("\0");
  const activeName =
    library.groups.find((group) => group.id === library.activeId)?.name ?? text().library.all;
  const customGroup = library.activeId !== "all";
  // 焦点可能停在工具栏/操作区上（这时 focusId 还是上一张卡），也可能因为换了分组而不在可见列表里 ——
  // 两种情况都必须回落到第一张，否则信息面板会对着一个已经看不到的游戏。
  const focused = shown.find((item) => item.id === focusId) ?? shown[0];
  const heroLeaving = useHeroCrossFade(shelf ? focused : undefined);
  const nameOf = (item: T) => library.names[item.id] || item.name;
  const shelfSummary = [
    text().library.gameCount(items.length),
    focused ? text().library.focusLine(nameOf(focused)) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // chip 上的数字是真的：全部 = 还没分组的（沿用旧语义，见 library.ungrouped），分组 = 组内张数。
  const chipCount = (groupId: string) =>
    items.filter((item) =>
      groupId === "all" ? !library.membership[item.id] : library.membership[item.id] === groupId,
    ).length;
  const cardStatus = status || hint || note;
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
      openCardMenu: (id) => {
        if (namingRef.current || deletingRef.current || hidingRef.current || pickingRef.current || restoringRef.current || menuRef.current || filePickRef.current || coverForRef.current || modForRef.current || blocked()) return false;
        const cardId =
          id ??
          (document.activeElement as HTMLElement | null)
            ?.closest("[data-card-id]")
            ?.getAttribute("data-card-id");
        if (!cardId) return false;
        // 菜单的定位与后续操作全按 id 走：从动作区点名打开时焦点还在按钮上，
        // 这里顺手把焦点交给那张卡，关掉菜单后回到的也是它（见下面的 closeDialog）。
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
    // 焦点在工具栏 / 分组 chip / 操作区上时不要抢回来：这些区域是自己能聚焦的，
    // 抢焦点会让 K1 操作区的按钮按不动（它不在卡片里，下面的卡片判断也救不了它）。
    if (current?.closest("[data-focus-zone='library-tools'], [data-focus-zone='library-groups'], [data-focus-zone='library-actions']")) return;
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

  // 聚焦项居中于内容区（画板 §3.3）。卡片是宽高过渡的（180ms），刚拿到焦点时量到的还是旧宽度 ——
  // 立刻居中一次、动画走完再补一次，否则会差半个身位（21dp 上下）。
  useLayoutEffect(() => {
    if (!shelf || !focusId) return;
    const strip = stripRef.current;
    if (!strip) return;
    const center = () => {
      const card = strip.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(focusId)}"]`);
      if (!card) return;
      const stripRect = strip.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const left =
        strip.scrollLeft + (cardRect.left - stripRect.left) - (strip.clientWidth - cardRect.width) / 2;
      strip.scrollTo({ left: Math.max(0, left), behavior: reduceMotion() ? "auto" : "smooth" });
    };
    center();
    const timer = window.setTimeout(center, 200);
    return () => window.clearTimeout(timer);
  }, [shelf, focusId, visibleKey]);

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

  /*
   * 卡片菜单贴着卡片放，并且**开着的时候一直跟着卡片走**。
   *
   * 两个坑都是真机反馈过的：
   *   ① 位置要「贴着」：以前是 `min(卡片顶, 屏高−菜单高)` —— 卡片在屏幕下半部分时（K1 的
   *      卡片条就在下半屏），菜单被顶到离卡片一大截的地方，用户的原话是「离主体特别远」。
   *      现在优先放卡片下方、放不下就贴到卡片上方，只有卡片高到上下都塞不进才夹一下。
   *   ② 量到的位置会变：卡片条在聚焦时会「平滑居中」，卡片自己还有 180ms 的放大过渡。
   *      只在开菜单那一帧量一次，菜单就会停在离卡片几十像素的地方。所以每帧跟着走，
   *      动画停下来它自然就不动了（`setMenuBox` 只在值真变了的时候才 setState）。
   */
  useLayoutEffect(() => {
    if (!menuCardId) {
      setMenuBox(null);
      return;
    }
    let frame = 0;
    const place = () => {
      const card = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(menuCardId)}"]`);
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const menu = document.querySelector<HTMLElement>(".card-menu");
      const width = Math.max(rect.width, menu?.offsetWidth ?? 0);
      const height = menu?.offsetHeight ?? 0;
      const gap = 8;
      const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
      const below = rect.bottom + gap;
      const above = rect.top - gap - height;
      const top =
        height > 0 && below + height <= window.innerHeight - 12
          ? below
          : height > 0 && above >= 12
            ? above
            : Math.max(12, Math.min(below, window.innerHeight - 12 - height));
      setMenuBox((current) => {
        const next = { top, left, width: rect.width };
        if (current && current.top === next.top && current.left === next.left && current.width === next.width) return current;
        return next;
      });
    };
    const follow = () => {
      place();
      frame = window.requestAnimationFrame(follow);
    };
    follow();
    return () => window.cancelAnimationFrame(frame);
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

  const chipClass = (active: boolean) =>
    ["group-chip", shelf || k2 ? "k1-chip" : "", active ? "is-current" : ""].filter(Boolean).join(" ");

  return (
    <main className={shelf ? "page library-page k1-page" : k2 ? "page library-page k2-page" : "page library-page"}>
      {/* K1 的顶部大图铺满内容区、卡片条压在图上（画板就是这样），图本身由页面给：
          宽图 → 封面 → 程序化占位这条回退链在页面侧，这里只管换图时的交叉淡入。 */}
      {shelf && renderHero && (
        <div className="k1-hero" aria-hidden>
          {heroLeaving && <span className="k1-hero-layer is-leaving">{renderHero(heroLeaving)}</span>}
          {focused && <span className="k1-hero-layer is-current">{renderHero(focused)}</span>}
          <span className="k1-hero-shade" />
        </div>
      )}
      <div className={shelf ? "library-head k1-head" : k2 ? "library-head k2-head" : "library-head"}>
        {shelf && (
          <div className="k1-title">
            <h2>{heading}</h2>
            <p className="k1-sub">{shelfSummary}</p>
          </div>
        )}
        {/* K2 的标题下面没有副标题（画板实测 78.5..94.5 之间没有字），状态行在底部操作条里 */}
        {k2 && heading && (
          <div className="k2-title">
            <h2>{heading}</h2>
            {/* 画板 K2：标题右边一句小结（「12 个已装软件 · 5 个预置可安装 · 3 个可更新」）。
                没有数据源的那两段（预置可安装 / 可更新）不写 —— 只写数得出来的。 */}
            {headingNote ? <p className="k2-title-note">{headingNote}</p> : null}
          </div>
        )}
        <div className="library-group-row" data-focus-zone="library-groups" aria-live="polite">
        <div className="group-strip">
          <span className="group-switch-side">LT</span>
          <div className="group-strip-scroll" role="tablist" aria-label={text().library.groups}>
            <button
              type="button"
              role="tab"
              aria-selected={library.activeId === "all"}
              className={chipClass(library.activeId === "all")}
              data-focusable
              onClick={() => {
                if (library.activeId === "all") return;
                playSfx("click");
                library.setActive("all");
              }}
            >
              {text().library.all}
              {(shelf || k2) && <span className="k1-chip-count tnum">{chipCount("all")}</span>}
            </button>
            {library.groups.map((group) => (
              <button
                key={group.id}
                type="button"
                role="tab"
                aria-selected={library.activeId === group.id}
                className={chipClass(library.activeId === group.id)}
                data-focusable
                onClick={() => {
                  if (library.activeId === group.id) return;
                  playSfx("click");
                  library.setActive(group.id);
                }}
              >
                {group.name}
                {(shelf || k2) && <span className="k1-chip-count tnum">{chipCount(group.id)}</span>}
              </button>
            ))}
          </div>
          <span className="group-switch-side">RT</span>
        </div>
        </div>
        <div className={shelf || k2 ? "library-tools k1-tools" : "library-tools"} data-focus-zone="library-tools">
          {k2 && searchPlaceholder ? (
            <div className="k2-search">
              {searching ? (
                <>
                  <SearchIcon />
                  <input
                    className="k2-search-input"
                    data-focusable
                    value={query}
                    placeholder={searchPlaceholder}
                    maxLength={40}
                    onChange={(event) => setQuery(event.target.value)}
                    onFocus={() => void showSoftKeyboard()}
                  />
                  <button
                    type="button"
                    className="k2-search-clear"
                    data-focusable
                    aria-label={text().library.searchClear}
                    onClick={() => {
                      // 有词就先清词、没词才收起输入框 —— 按一下同时干两件事会让人不知道发生了什么。
                      if (query) setQuery("");
                      else setSearching(false);
                    }}
                  >
                    ✕
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="k2-search-open"
                  data-focusable
                  onClick={() => {
                    setSearching(true);
                    // 掌机上直接叫系统软键盘：手柄一格一格挪虚拟键盘太难用。
                    window.setTimeout(() => {
                      document.querySelector<HTMLInputElement>(".k2-search-input")?.focus();
                    }, 0);
                  }}
                >
                  <SearchIcon />
                  <span>{query || searchPlaceholder}</span>
                </button>
              )}
            </div>
          ) : null}
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
        {!shelf && !k2 && <p className="preview-note">{cardStatus}</p>}
      </div>
      {shelf ? (
        <div className="k1-strip-wrap">
          {visible.length === 0 ? (
            <p className="group-empty k1-empty">
              {customGroup && items.length > 0 ? text().library.noCards : text().library.ungrouped}
            </p>
          ) : (
            <section
              ref={stripRef}
              key={library.activeId}
              className="k1-strip"
              data-focus-zone="library-grid"
              aria-label={label}
            >
              {visible.map((item, index) => (
                // 外面的 div 只为量焦点/放大：卡片本身是页面给的（保持 useLocalLibrary 那边一行不动），
                // 聚焦事件从卡片冒泡到这里，就能知道"现在聚焦哪张"。
                <div
                  key={item.id}
                  className={focused?.id === item.id ? "k1-item is-current" : "k1-item"}
                  onFocus={() => setFocusId(item.id)}
                >
                  {renderCard(item, index === 0 ? firstRef : undefined, {
                    variant: "shelf",
                    focused: focused?.id === item.id,
                    name: library.names[item.id] || item.name,
                  })}
                </div>
              ))}
            </section>
          )}
        </div>
      ) : shown.length === 0 && items.length > 0 && !needle ? (
        <p className="group-empty">
          {customGroup
            ? text().library.noCards
            : text().library.ungrouped}
        </p>
      ) : shown.length === 0 && needle ? (
        // 关键词一个都没命中：说清楚是「搜不到」而不是「库是空的」（画板 ui-strings 原话）。
        <p className="group-empty">{text().library.noSearchHit}</p>
      ) : shown.length === 0 ? null : (
        <section
          key={library.activeId}
          className={k2 ? "k2-grid motion-stagger" : "library-grid motion-stagger"}
          data-focus-zone="library-grid"
          aria-label={label}
          // K2 底部那条要跟着聚焦卡片变，所以网格也要认焦点：卡片上已经带了 data-card-id，
          // 事件从卡片冒泡到这里就够了（不为每张卡包一层 div，K2 的网格是严格的 6 列）。
          onFocus={(event) => {
            if (!k2) return;
            const id = (event.target as HTMLElement).dataset?.cardId;
            if (id) setFocusId(id);
          }}
        >
          {shown.map((item, index) =>
            renderCard(item, index === 0 ? firstRef : undefined, {
              variant: k2 ? "grid" : "picker",
              name: library.names[item.id] || item.name,
              running: runningIds?.has(item.id),
            }),
          )}
        </section>
      )}
      {/* K2 的底部操作条（画板 y=554..602）：左边是**聚焦那一张**的名字 + 元信息，
          右边两颗真按钮（画板上是「安装 A」+「打开目录」；页面侧给，见 renderBar）。
          没传 renderBar 就退化成原来的「重新扫描 / 添加软件」—— 那两个能力只是换了入口。 */}
      {k2 && (
        <div className="k2-bar" data-focus-zone="library-actions">
          {renderBar ? (
            renderBar(focused ?? null, { name: focused ? nameOf(focused) : "", status: cardStatus })
          ) : (
            <>
              <p className="k2-bar-note">{cardStatus}</p>
              <button
                type="button"
                className="k2-btn is-primary"
                data-focusable
                disabled={scanning}
                onClick={onScan}
              >
                {text().library.rescan}
              </button>
              <button
                type="button"
                className="k2-btn"
                data-focusable
                onClick={() => setFileTarget({ mode: "add" })}
              >
                {kind === "games" ? text().library.addGame : text().library.addApp}
              </button>
            </>
          )}
        </div>
      )}
      {/* 信息面板 + 操作区：内容全在页面侧（游戏库才知道来源/路径/运行状态），
          这里只保证「聚焦项一变它就跟着变」。 */}
      {shelf && focused && (
        <div className="k1-foot">
          <section className="k1-panel" aria-label={text().library.focusLabel}>
            {renderInfo?.(focused, { name: nameOf(focused) })}
          </section>
          <div className="k1-actions" data-focus-zone="library-actions">
            {renderActions?.(focused, { name: nameOf(focused), status: cardStatus })}
          </div>
        </div>
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
                {modState?.dir && (
                  <p className="group-empty">
                    {modState.exe
                      ? text().library.modsExe(modState.exe)
                      : text().library.modsNoExe}
                  </p>
                )}
                <p className="group-empty">
                  {modState?.installed
                    ? modState.version
                      ? text().library.modsInstalled(modState.version, modState.hook ?? modHook)
                      : text().library.modsInstalledLegacy
                    : text().library.modsHookHint}
                </p>
                {/*
                  这个游戏会加载哪些名字：读它自己的导入表算出来的（不是按游戏名打表），
                  所以「换一个游戏就要改一次代码」这件事不再发生 —— 用户看到的默认值就是对的。
                */}
                {!modState?.installed && (modState?.hookCandidates?.length ?? 0) > 0 && (
                  <p className="group-empty">
                    {text().library.modsCandidates((modState?.hookCandidates ?? []).join(" / "))}
                  </p>
                )}
                {/* 装完之后的实况：日志有没有出现，就是「到底加载上没有」的唯一硬证据。 */}
                {modState?.installed && (
                  <p className="group-empty">
                    {modState.logSeen
                      ? text().library.modsLoaded
                      : text().library.modsNotLoaded}
                  </p>
                )}
                {/* 「支不支持 FSR 4.1.1」只看那个放大器文件在不在（账本里记着），不靠版本名猜。 */}
                {modState?.installed && (
                  <p className="group-empty">
                    {modState.fsr4
                      ? text().library.modsFsr4
                      : text().library.modsFsr4Official}
                  </p>
                )}
                {/*
                  注入名按钮：没装时是「选哪个装」，装了但没加载上时是「换一个再试」——
                  后者才是关键：用户不用等我们改代码，自己点一下就换下一个名字。
                */}
                {(!modState?.installed || !modState.logSeen) && (
                  <div className="library-tools">
                    {(() => {
                      // 会加载的名字排前面（它们才可能生效），其余按官方顺序跟在后面。
                      const all = modState?.hooks?.length ? modState.hooks : [DEFAULT_MOD_HOOK];
                      const listed = modState?.hookCandidates ?? [];
                      const ordered = [
                        ...listed,
                        ...all.filter((hook) => !listed.includes(hook)),
                      ];
                      return ordered.map((hook) => (
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
                          {(modState?.triedHooks ?? []).includes(hook) ? " ·✗" : ""}
                        </button>
                      ));
                    })()}
                  </div>
                )}
                {/* 一键换名重装：把「下一个该试哪个」直接摆到按钮上，用户不用理解原理，
                    也不用等我们发版 —— 按一下就是「换成这个名字再装一遍」。 */}
                {modState?.installed &&
                  !modState.logSeen &&
                  modState.suggestedHook &&
                  modState.suggestedHook !== modHook &&
                  onInstallMods && (
                    <div className="library-tools">
                      <button
                        type="button"
                        className="library-tool is-current"
                        data-focusable
                        onClick={() => {
                          const id = modFor.id;
                          const next = modState.suggestedHook as string;
                          setModHook(next);
                          setModBusy(true);
                          void Promise.resolve(onInstallMods(id, next, modTag ?? undefined)).then(
                            (message) => {
                              setHint(message);
                              setModBusy(false);
                              if (onModStatus) void onModStatus(id, next).then(setModState);
                            },
                          );
                        }}
                      >
                        {text().library.modsSwitchTo(modState.suggestedHook)}
                      </button>
                    </div>
                  )}
                {modState?.triedHooks && modState.triedHooks.length > 0 && (
                  <p className="group-empty">
                    {text().library.modsTried(modState.triedHooks.join(" → "))}
                  </p>
                )}
                {modState?.arch && (
                  <p className="group-empty">{text().library.modsArch(modState.arch)}</p>
                )}
                {modState?.running && <p className="group-empty">{text().library.modsRunning}</p>}
                {modState?.conflict && (
                  <p className="group-empty">{text().library.modsConflict(modState.conflict)}</p>
                )}
                {!modState?.installed && modVersions.length > 1 && (
                  <div className="library-tools">
                    {(() => {
                      // 默认选中的是**首选那一版**：没点过（modTag = null）时有自带版就是它，
                      // 没有才是官方最新；点过哪一版之后就按点的那一版走。
                      const hasBundled = modVersions.some((entry) => entry.bundled);
                      return modVersions.map((entry) => {
                        const current =
                          modTag === null
                            ? entry.bundled || (!hasBundled && entry.latest)
                            : modTag === entry.tag;
                        return (
                          <button
                            key={entry.tag}
                            type="button"
                            className={`library-tool${current ? " is-current" : ""}`}
                            data-focusable
                            onClick={() => setModTag(entry.tag)}
                          >
                            {entry.bundled
                              ? text().library.modsBundled
                              : entry.latest
                                ? `v${entry.version} · ${text().library.modsLatest}`
                                : `v${entry.version}`}
                          </button>
                        );
                      });
                    })()}
                  </div>
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
                        void Promise.resolve(onInstallMods(id, modHook, modTag ?? undefined)).then((message) => {
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
                      setModTag(null);
                      // 版本列表与状态一起问：列表拿不到就按「装最新」走，不挡路。
                      void onModVersions?.().then(setModVersions);
                      // 先问状态：装哪儿、装了没有、会不会冲突 —— 让用户带着事实决定，
                      // 而不是点一下才发现装到了别的目录（老实现就是闷着装的）。
                      if (onModStatus) {
                        setModLoading(true);
                        void onModStatus(id, DEFAULT_MOD_HOOK).then((state) => {
                          setModState(state);
                          // 默认值取「这个游戏真的会加载」的第一个名字（读它自己的导入表得出的），
                          // 认不出来才是官方的 dxgi.dll —— 不是按游戏名打表。
                          if (state?.defaultHook && !state.installed) {
                            setModHook(state.defaultHook);
                          }
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
                  variant: "picker",
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
                    variant: "picker",
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
