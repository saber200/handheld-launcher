import { useEffect, useRef, useState, type Ref } from "react";
import { displayGameName } from "../data/previewGames";
import { currentLocale, text } from "../i18n";
import { LibraryShelf } from "../components/LibraryShelf";
import { MenuIcon, PlayIcon } from "../components/NavIcons";
import { libraryActions } from "../library/actions";
import { formatPlaytime, formatPlaytimeAndSize, formatSize } from "../library/format";
import { type GameEntry } from "../data/previewGames";
import {
  cancelLibraryGameMods,
  installLibraryGameMods,
  launchLibraryItem,
  modStatus,
  modVersions,
  quitLibraryGame,
  uninstallLibraryGameMods,
  useLocalGames,
  useRunningGameIds,
} from "../library/useLocalLibrary";

export function GamesPage() {
  const library = useLocalGames();
  const running = useRunningGameIds(library.items);
  const [status, setStatus] = useState("");

  /** 卡片条上按 A / 点「开始游戏」走的就是这一条 —— 和旧网格卡片的启动路径完全一样。 */
  const launch = (game: GameEntry, name: string) => {
    setStatus("");
    void launchLibraryItem({
      id: game.id,
      name,
      launchPath: game.launchPath,
      installPath: game.installPath,
      customPath: game.customPath,
      switchIfRunning: true,
    }).then(setStatus);
  };

  return (
    <LibraryShelf
      kind="games"
      layout="shelf"
      heading={text().tabs.games}
      items={library.items}
      label={text().tabs.games}
      note={library.note}
      status={status}
      onUseFile={(target, file) => {
        setStatus("");
        return target.mode === "add" ? library.addFromFile(file) : library.setLaunchPath(target.id, file);
      }}
      onHide={(id) => {
        setStatus("");
        return library.hide(id);
      }}
      onQuit={(id) => {
        const game = library.items.find((item) => item.id === id);
        if (!game) return text().library.failed;
        setStatus("");
        return quitLibraryGame({
          id: game.id,
          name: game.name,
          launchPath: game.launchPath,
          installPath: game.installPath,
          customPath: game.customPath,
        }).then((message) => {
          setStatus(message);
          return message;
        });
      }}
      runningIds={running}
      restorable={library.restorable}
      onRestore={(id) => {
        setStatus("");
        return library.restore(id);
      }}
      onSteamCover={(id, appId) => {
        setStatus("");
        return library.setSteamCover(id, appId);
      }}
      onInstallMods={(id, hook, version) => {
        const game = library.items.find((item) => item.id === id);
        if (!game) return text().library.failed;
        setStatus("");
        return installLibraryGameMods(
          { name: game.name, launchPath: game.launchPath, installPath: game.installPath },
          hook,
          version,
        );
      }}
      onModVersions={() => modVersions()}
      onModStatus={(id, hook) => {
        const game = library.items.find((item) => item.id === id);
        if (!game) return Promise.resolve(null);
        return modStatus(
          { name: game.name, launchPath: game.launchPath, installPath: game.installPath },
          hook,
        );
      }}
      onUninstallMods={(id) => {
        const game = library.items.find((item) => item.id === id);
        if (!game) return text().library.failed;
        setStatus("");
        return uninstallLibraryGameMods({
          name: game.name,
          launchPath: game.launchPath,
          installPath: game.installPath,
        });
      }}
      onCancelMods={() => void cancelLibraryGameMods()}
      scanning={library.scanning}
      onScan={() => setStatus(library.rescan())}
      renderHero={(game) => <GameHero game={game} />}
      renderInfo={(game, ctx) => (
        <GameInfo
          game={game}
          name={displayGameName(game.id, ctx.name, currentLocale())}
          running={running.has(game.id)}
        />
      )}
      renderActions={(game, ctx) => (
        <GameActions
          status={ctx.status}
          running={running.has(game.id)}
          onLaunch={() => launch(game, ctx.name)}
          onQuit={() => {
            setStatus("");
            void quitLibraryGame({
              id: game.id,
              name: ctx.name,
              launchPath: game.launchPath,
              installPath: game.installPath,
              customPath: game.customPath,
            }).then(setStatus);
          }}
          onMenu={() => libraryActions().openCardMenu?.(game.id)}
        />
      )}
      renderCard={(game, cardRef, options) => (
        <GameCard
          key={game.id}
          game={game}
          cardRef={cardRef}
          // 卡片条跟两个选择对话框画法不同（见 GameCard 的 variant）：这里必须把
          // LibraryShelf 给的 variant 传下去，漏了就会在卡片条里画成旧网格卡片。
          variant={options?.variant}
          focusedMeta={options?.focused}
          picked={options?.picked}
          onPick={options?.onPick}
          name={options?.name}
          running={running.has(game.id)}
          onStatus={setStatus}
        />
      )}
    />
  );
}

function GameCard({
  game,
  cardRef,
  picked,
  onPick,
  name,
  running,
  onStatus,
  variant = "picker",
  focusedMeta = false,
}: {
  game: GameEntry;
  cardRef?: Ref<HTMLButtonElement>;
  picked?: boolean;
  onPick?: () => void;
  name?: string;
  running?: boolean;
  onStatus: (message: string) => void;
  /**
   * `"shelf"` = K1 卡片条上的样式（固定 116×146 的盒子，名字压在封面上）；
   * `"picker"`（默认）= 旧网格卡片 —— 两个选择对话框还在用它，别一起改。
   */
  variant?: "shelf" | "picker";
  /** 聚焦卡才露「时长 · 体积」那一行（画板 §3.2）。 */
  focusedMeta?: boolean;
}) {
  const shelf = variant === "shelf";
  const [src, setSrc] = useState(game.cover);
  const [failed, setFailed] = useState(false);
  const triesRef = useRef(0);

  useEffect(() => {
    setSrc(game.cover);
    setFailed(false);
    triesRef.current = 0;
  }, [game.cover, game.coverRemote]);

  const title = name || displayGameName(game.id, game.name, currentLocale());

  /** 封面回退链：本地 asset:// → 加时间戳重试（一次）→ 远端封面 → 程序化占位。 */
  const cover =
    failed || !src ? (
      <span className={`${shelf ? "game-cover k1-cover " : "game-cover "}game-cover-fallback`} aria-hidden />
    ) : (
      <img
        className={shelf ? "game-cover k1-cover" : "game-cover"}
        src={src}
        alt=""
        onError={() => {
          triesRef.current += 1;
          // WebView asset protocol can flake when many cards remount on group switch.
          if (triesRef.current === 1 && game.cover && src === game.cover) {
            const join = game.cover.includes("?") ? "&" : "?";
            setSrc(`${game.cover}${join}r=${Date.now()}`);
            return;
          }
          if (game.coverRemote && src !== game.coverRemote) {
            setSrc(game.coverRemote);
            return;
          }
          setFailed(true);
        }}
      />
    );

  const activate = () => {
    if (onPick) {
      onPick();
      return;
    }
    void launchLibraryItem({
      id: game.id,
      name: title,
      launchPath: game.launchPath,
      installPath: game.installPath,
      customPath: game.customPath,
      switchIfRunning: true,
    }).then(onStatus);
  };

  if (shelf) {
    // 画板 §3.2：卡片里只有名称（未聚焦一行、聚焦两行）；**聚焦那张**再带一行「时长 · 体积」。
    // 这一行只在真有数的时候才出现（Rust 那边 0 = 不知道），拿不到就整行不画 —— 不留空行、
    // 也不写「0 GB」。两个数都没有时，卡片看起来就跟 M1 一样（只有名称）。
    const facts = focusedMeta ? formatPlaytimeAndSize(game.playtimeMinutes, game.sizeBytes) : "";
    return (
      <button
        ref={cardRef}
        type="button"
        className={["library-card", "k1-card", running ? "is-running" : "", facts ? "has-facts" : ""]
          .filter(Boolean)
          .join(" ")}
        data-focusable
        data-card-id={game.id}
        onClick={activate}
      >
        {cover}
        <span className="library-name">{title}</span>
        {facts && <span className="k1-card-facts tnum">{facts}</span>}
        {running && <span className="k1-run-dot" aria-hidden />}
        <span className="k1-a" aria-hidden>
          A
        </span>
      </button>
    );
  }

  return (
    <button
      ref={cardRef}
      type="button"
      className={["library-card", picked ? "is-picked" : "", running ? "is-running" : ""].filter(Boolean).join(" ")}
      data-focusable
      data-card-id={game.id}
      onClick={activate}
    >
      {picked && <span className="pick-mark">✓</span>}
      {cover}
      <span className="library-name">{title}</span>
    </button>
  );
}

/**
 * 库里的 id 前缀就是来源：扫描出来的 Steam / Epic 游戏带 `steam:` / `epic:` 前缀
 * （见 src-tauri/src/scan.rs），其余是用户手动添加的程序。浏览器预览里的 12 个样例
 * 用的是裸 appid，这里按数字也算 Steam，免得预览页整排都写「手动添加」。
 */
function platformOf(game: GameEntry): string {
  if (game.id.startsWith("steam:") || /^\d+$/.test(game.id)) return text().library.platformSteam;
  if (game.id.startsWith("epic:")) return text().library.platformEpic;
  return text().library.platformManual;
}

/**
 * 顶部大图（画板 K1 的 hero，396dp 高）。
 *
 * 回退链：Steam 宽图（`library_hero.jpg`）→ 卡片封面 → 程序化占位。
 * 为什么宽图直接打 CDN：本地只缓存 600×900 的竖封面（`cache_covers`），宽图没有落盘的地方，
 * 要为它加一套缓存是 M6 之后的事。**只有当前聚焦的那一张会请求**（换图时最多两张），
 * 断网 / Epic / 手动添加的游戏直接走封面，不重试、不转圈。
 */
function GameHero({ game }: { game: GameEntry }) {
  const wide = (() => {
    const appId = game.id.startsWith("steam:") ? game.id.slice(6) : /^\d+$/.test(game.id) ? game.id : "";
    return appId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_hero.jpg` : "";
  })();
  const [src, setSrc] = useState(wide || game.cover || "");
  useEffect(() => {
    setSrc(wide || game.cover || "");
  }, [wide, game.cover, game.id]);
  if (!src) return <span className="k1-hero-fallback" aria-hidden />;
  return (
    <img
      className="k1-hero-img"
      src={src}
      alt=""
      decoding="async"
      onError={() => {
        // 宽图 404 / 断网 → 退回封面；封面也失败就交给占位（不再往下试，避免来回抖）。
        setSrc((current) => (current && game.cover && current !== game.cover ? game.cover : ""));
      }}
    />
  );
}

/**
 * 信息面板（画板上是 430×138 的卡片）。
 *
 * **只写真字段**：名称、来源、运行状态、占用空间、总时长、安装位置。
 * 画板那四格里的「最近游玩 / 兼容性」本地没有数据源（前者要 Steam 的 last played、
 * 后者要一份兼容性清单），所以不画；「总时长 / 占用空间」现在是真数据了
 * （Rust 扫描：Steam 的 appmanifest / localconfig、Epic 的 manifest；见 scan.rs），
 * 拿不到的那一条自己会消失，不留空行。
 */
function GameInfo({ game, name, running }: { game: GameEntry; name: string; running: boolean }) {
  const platform = platformOf(game);
  // Steam / Epic 的 launchPath 是 steam:// 这类地址，没有安装路径时别把它当路径显示出来。
  const path = game.installPath || (game.launchPath?.includes("://") ? "" : game.launchPath) || "";
  const size = formatSize(game.sizeBytes);
  const playtime = formatPlaytime(game.playtimeMinutes);
  return (
    <>
      <h3 className="k1-info-name">{name}</h3>
      <dl className="k1-info-fields">
        <dt>{text().library.fieldSource}</dt>
        <dd>{platform}</dd>
        <dt>{text().library.fieldState}</dt>
        <dd className={running ? "is-running" : undefined}>
          {running ? text().library.stateRunning : text().library.stateIdle}
        </dd>
        {size && (
          <>
            <dt>{text().library.fieldSize}</dt>
            <dd className="tnum">{size}</dd>
          </>
        )}
        {playtime && (
          <>
            <dt>{text().library.fieldPlaytime}</dt>
            <dd className="tnum">{playtime}</dd>
          </>
        )}
        <dt>{text().library.fieldPath}</dt>
        <dd className="k1-path" title={path || undefined}>
          {path || "—"}
        </dd>
      </dl>
    </>
  );
}

/**
 * 操作区：主按钮 + 卡片菜单 + 状态行。
 *
 * 运行中的游戏多一个「退出」—— 走的是卡片菜单里同一个 `quit_game` 命令，不是新能力。
 * 卡片菜单按钮点的是**当前这张卡**（把 id 传进去），所以焦点停在操作区时也能开菜单。
 */
function GameActions({
  status,
  running,
  onLaunch,
  onQuit,
  onMenu,
}: {
  status: string;
  running: boolean;
  onLaunch: () => void;
  onQuit: () => void;
  onMenu: () => void;
}) {
  return (
    <>
      <div className="k1-btn-row">
        <button type="button" className="k1-btn is-primary" data-focusable onClick={onLaunch}>
          <PlayIcon />
          {text().library.startGame}
        </button>
        {running && (
          <button type="button" className="k1-btn" data-focusable onClick={onQuit}>
            {text().library.quitGame}
          </button>
        )}
        <button
          type="button"
          className="k1-btn is-icon"
          data-focusable
          aria-label={text().library.cardMenu}
          title={text().library.cardMenu}
          onClick={onMenu}
        >
          <MenuIcon />
        </button>
      </div>
      {status && <p className="k1-status">{status}</p>}
    </>
  );
}
