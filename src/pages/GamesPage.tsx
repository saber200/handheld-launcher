import { useEffect, useState, type Ref } from "react";
import { displayGameName } from "../data/previewGames";
import { currentLocale, text } from "../i18n";
import { LibraryShelf } from "../components/LibraryShelf";
import { type GameEntry } from "../data/previewGames";
import { launchLibraryItem, quitLibraryGame, useLocalGames, useRunningGameIds } from "../library/useLocalLibrary";

export function GamesPage() {
  const library = useLocalGames();
  const running = useRunningGameIds(library.items);
  const [status, setStatus] = useState("");
  return (
    <LibraryShelf
      kind="games"
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
      onSteamCover={(id, appId) => {
        setStatus("");
        return library.setSteamCover(id, appId);
      }}
      scanning={library.scanning}
      onScan={() => setStatus(library.rescan())}
      renderCard={(game, cardRef, options) => (
        <GameCard
          key={game.id}
          game={game}
          cardRef={cardRef}
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
}: {
  game: GameEntry;
  cardRef?: Ref<HTMLButtonElement>;
  picked?: boolean;
  onPick?: () => void;
  name?: string;
  running?: boolean;
  onStatus: (message: string) => void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => {
    setCoverFailed(false);
  }, [game.cover]);

  return (
    <button
      ref={cardRef}
      type="button"
      className={["library-card", picked ? "is-picked" : "", running ? "is-running" : ""].filter(Boolean).join(" ")}
      data-focusable
      data-card-id={game.id}
      onClick={() => {
        if (onPick) {
          onPick();
          return;
        }
        void launchLibraryItem({
          id: game.id,
          name: name || game.name,
          launchPath: game.launchPath,
          installPath: game.installPath,
          customPath: game.customPath,
          switchIfRunning: true,
        }).then(onStatus);
      }}
    >
      {picked && <span className="pick-mark">✓</span>}
      {coverFailed || !game.cover ? (
        <span className="game-cover game-cover-fallback" aria-hidden />
      ) : (
        <img
          className="game-cover"
          src={game.cover}
          alt=""
          onError={() => setCoverFailed(true)}
        />
      )}
      <span className="library-name">{name || displayGameName(game.id, game.name, currentLocale())}</span>
    </button>
  );
}
