import { useState, type Ref } from "react";
import { displayAppMark, displayAppName } from "../data/previewApps";
import { currentLocale, text } from "../i18n";
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
      label={text().tabs.apps}
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
      restorable={library.restorable}
      onRestore={(id) => {
        setStatus("");
        return library.restore(id);
      }}
      scanning={library.scanning}
      onScan={() => setStatus(library.rescan())}
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
          customPath: app.customPath,
        }).then(onStatus);
      }}
    >
      {picked && <span className="pick-mark">✓</span>}
      {app.icon ? (
        <img className="app-icon app-icon-image" src={app.icon} alt="" />
      ) : (
        <span className="app-icon" style={{ background: app.color }} aria-hidden>
          {displayAppMark(app.id, app.mark, currentLocale())}
        </span>
      )}
      <span className="library-name">{name || displayAppName(app.id, app.name, currentLocale())}</span>
    </button>
  );
}
