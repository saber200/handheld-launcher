import { useEffect, useState, type Ref } from "react";
import { LibraryShelf } from "../components/LibraryShelf";
import { type GameEntry } from "../data/previewGames";
import { launchLibraryItem, useLocalGames } from "../library/useLocalLibrary";

export function GamesPage() {
  const library = useLocalGames();
  const [status, setStatus] = useState("");
  return (
    <LibraryShelf
      kind="games"
      items={library.items}
      label="游戏库"
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
  onStatus,
}: {
  game: GameEntry;
  cardRef?: Ref<HTMLButtonElement>;
  picked?: boolean;
  onPick?: () => void;
  name?: string;
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
      className={picked ? "library-card is-picked" : "library-card"}
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
      <span className="library-name">{name || game.name}</span>
    </button>
  );
}
