import { useState, type Ref } from "react";
import { LibraryShelf } from "../components/LibraryShelf";
import { type AppEntry } from "../data/previewApps";
import { launchLibraryItem, useLocalApps } from "../library/useLocalLibrary";

export function AppsPage() {
  const library = useLocalApps();
  const [status, setStatus] = useState("");
  return (
    <LibraryShelf
      kind="apps"
      items={library.items}
      label="软件库"
      note={status || library.note}
      renderCard={(app, cardRef, options) => (
        <AppCard
          key={app.id}
          app={app}
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

function AppCard({
  app,
  cardRef,
  picked,
  onPick,
  name,
  onStatus,
}: {
  app: AppEntry;
  cardRef?: Ref<HTMLButtonElement>;
  picked?: boolean;
  onPick?: () => void;
  name?: string;
  onStatus: (message: string) => void;
}) {
  return (
    <button
      ref={cardRef}
      type="button"
      className={picked ? "library-card is-picked" : "library-card"}
      data-focusable
      data-card-id={app.id}
      onClick={() => {
        if (onPick) {
          onPick();
          return;
        }
        void launchLibraryItem({
          id: app.id,
          name: name || app.name,
          launchPath: app.launchPath,
          installPath: app.installPath,
        }).then(onStatus);
      }}
    >
      {picked && <span className="pick-mark">✓</span>}
      <span className="app-icon" style={{ background: app.color }} aria-hidden>
        {app.mark}
      </span>
      <span className="library-name">{name || app.name}</span>
    </button>
  );
}
