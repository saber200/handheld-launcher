import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { text } from "../i18n";

type RuntimePackage = {
  id: string;
  name: string;
  detail: string;
  installed: boolean;
};

type LibraryGame = {
  id: string;
  name: string;
  launchPath: string;
  installPath: string;
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readLibraryGames(): LibraryGame[] {
  const hidden = new Set<string>();
  const pathOverrides: Record<string, { launchPath?: string; installPath?: string }> = {};
  const added: LibraryGame[] = [];
  try {
    const extrasRaw = localStorage.getItem("handheld-launcher.files.games");
    if (extrasRaw) {
      const extras = JSON.parse(extrasRaw) as {
        hidden?: string[];
        paths?: Record<string, { launchPath?: string; installPath?: string }>;
        added?: Array<{ id?: string; name?: string; launchPath?: string; installPath?: string }>;
      };
      for (const id of extras.hidden ?? []) {
        if (typeof id === "string") hidden.add(id);
      }
      if (extras.paths && typeof extras.paths === "object") {
        Object.assign(pathOverrides, extras.paths);
      }
      for (const row of extras.added ?? []) {
        if (!row || typeof row.id !== "string" || typeof row.name !== "string") continue;
        if (typeof row.launchPath !== "string" || !row.launchPath) continue;
        added.push({
          id: row.id,
          name: row.name,
          launchPath: row.launchPath,
          installPath: typeof row.installPath === "string" ? row.installPath : "",
        });
      }
    }
  } catch {
    /* ignore */
  }

  const scanned: LibraryGame[] = [];
  try {
    const scanRaw = localStorage.getItem("handheld-launcher.scan.scan_games");
    if (scanRaw) {
      const rows = JSON.parse(scanRaw) as Array<{
        id?: string;
        name?: string;
        launchPath?: string;
        installPath?: string;
      }>;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!row || typeof row.id !== "string" || typeof row.name !== "string") continue;
          if (hidden.has(row.id)) continue;
          const override = pathOverrides[row.id];
          const launchPath =
            (override?.launchPath && override.launchPath) ||
            (typeof row.launchPath === "string" ? row.launchPath : "");
          if (!launchPath) continue;
          scanned.push({
            id: row.id,
            name: row.name,
            launchPath,
            installPath:
              (override?.installPath && override.installPath) ||
              (typeof row.installPath === "string" ? row.installPath : ""),
          });
        }
      }
    }
  } catch {
    /* ignore */
  }

  const byId = new Map<string, LibraryGame>();
  for (const game of [...scanned, ...added]) {
    if (hidden.has(game.id)) continue;
    byId.set(game.id, game);
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

type Props = { active: boolean };

export function ToolboxPanel({ active }: Props) {
  const m = text().frontend;
  const [runtimes, setRuntimes] = useState<RuntimePackage[]>([]);
  const [games, setGames] = useState<LibraryGame[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busyId, setBusyId] = useState("");
  const [optiBusy, setOptiBusy] = useState(false);
  const [optiInstalled, setOptiInstalled] = useState(false);
  const [note, setNote] = useState("");

  const refreshRuntimes = () => {
    if (!inTauri()) {
      setRuntimes([]);
      setNote(m.toolboxPreview);
      return;
    }
    void invoke<RuntimePackage[]>("toolbox_runtimes")
      .then(setRuntimes)
      .catch((err) => setNote(m.toolboxFailed(String(err))));
  };

  useEffect(() => {
    if (!active) return;
    setGames(readLibraryGames());
    refreshRuntimes();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const selected = games.find((game) => game.id === selectedId) ?? games[0];
    if (!selected) {
      setSelectedId("");
      setOptiInstalled(false);
      return;
    }
    if (selected.id !== selectedId) setSelectedId(selected.id);
    if (!inTauri()) {
      setOptiInstalled(false);
      return;
    }
    void invoke<boolean>("toolbox_optiscaler_installed", { launchPath: selected.launchPath })
      .then(setOptiInstalled)
      .catch(() => setOptiInstalled(false));
  }, [active, games, selectedId]);

  const installRuntime = async (id: string) => {
    if (!inTauri()) {
      setNote(m.toolboxPreview);
      return;
    }
    setBusyId(id);
    setNote(m.toolboxInstalling);
    try {
      const message = await invoke<string>("toolbox_install_runtime", { id });
      setNote(message);
      refreshRuntimes();
    } catch (err) {
      setNote(m.toolboxFailed(String(err)));
    } finally {
      setBusyId("");
    }
  };

  const installOptiscaler = async () => {
    const selected = games.find((game) => game.id === selectedId);
    if (!selected) {
      setNote(m.optiscalerNoGame);
      return;
    }
    if (!inTauri()) {
      setNote(m.toolboxPreview);
      return;
    }
    setOptiBusy(true);
    setNote(m.optiscalerInstalling);
    try {
      const message = await invoke<string>("toolbox_install_optiscaler", {
        launchPath: selected.launchPath,
      });
      setNote(message);
      setOptiInstalled(true);
    } catch (err) {
      setNote(m.toolboxFailed(String(err)));
    } finally {
      setOptiBusy(false);
    }
  };

  const selected = games.find((game) => game.id === selectedId) ?? null;
  const anyBusy = busyId !== "" || optiBusy;

  return (
    <div className="toolbox-panel">
      <section className="toolbox-block">
        <h3 className="toolbox-block-title">{m.runtimesTitle}</h3>
        <p className="toolbox-block-body">{m.runtimesBody}</p>
        {runtimes.length === 0 && inTauri() ? (
          <p className="tdp-status">{m.runtimesEmpty}</p>
        ) : null}
        <div className="toolbox-list">
          {runtimes.map((pkg) => (
            <div key={pkg.id} className="toolbox-row">
              <span>
                <strong>{pkg.name}</strong>
                <small>{pkg.detail}</small>
              </span>
              <button
                type="button"
                className={`library-tool${pkg.installed ? " on" : ""}`}
                data-focusable
                disabled={anyBusy}
                onClick={() => void installRuntime(pkg.id)}
              >
                {busyId === pkg.id
                  ? m.toolboxWorking
                  : pkg.installed
                    ? m.toolboxReinstall
                    : m.toolboxInstall}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="toolbox-block">
        <h3 className="toolbox-block-title">{m.optiscalerTitle}</h3>
        <p className="toolbox-block-body">{m.optiscalerBody}</p>
        {games.length === 0 ? (
          <p className="tdp-status">{m.optiscalerNoGame}</p>
        ) : (
          <>
            <label className="toolbox-select-row">
              <span>{m.optiscalerPick}</span>
              <select
                className="toolbox-select"
                data-focusable
                value={selected?.id ?? ""}
                disabled={anyBusy}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {games.map((game) => (
                  <option key={game.id} value={game.id}>
                    {game.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="setting-row"
              data-focusable
              disabled={anyBusy || !selected}
              onClick={() => void installOptiscaler()}
            >
              <span>
                <strong>{m.optiscalerInstall}</strong>
                <small>
                  {optiInstalled ? m.optiscalerInstalled : m.optiscalerHint}
                </small>
              </span>
              <span className="switch">{optiBusy ? m.toolboxWorking : m.toolboxInstall}</span>
            </button>
          </>
        )}
      </section>

      {note ? <p className="tdp-status">{note}</p> : null}
    </div>
  );
}
