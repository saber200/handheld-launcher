import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HomePage } from "./pages/HomePage";
import { GamesPage } from "./pages/GamesPage";
import { AppsPage } from "./pages/AppsPage";
import { FilesPage } from "./pages/FilesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useGamepadNav } from "./hooks/useGamepadNav";
import type { PageId } from "./types";

export default function App() {
  const [page, setPage] = useState<PageId>("home");

  useEffect(() => {
    const win = getCurrentWindow();
    void win.setFullscreen(true).catch(() => {
      // Browser preview / non-tauri fallback
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && page !== "home") {
        e.preventDefault();
        setPage("home");
        return;
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>("[data-focusable]"),
        ).filter((el) => el.offsetParent !== null);
        if (nodes.length === 0) return;
        const active = document.activeElement as HTMLElement | null;
        let index = Math.max(0, nodes.findIndex((n) => n === active));
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          index = (index + 1) % nodes.length;
        } else {
          index = (index - 1 + nodes.length) % nodes.length;
        }
        nodes[index]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page]);

  const goHome = useCallback(() => setPage("home"), []);

  useGamepadNav({
    onBack: () => {
      if (page !== "home") setPage("home");
    },
  });

  return (
    <div className="app-shell">
      <div className="ambient" aria-hidden />
      {page === "home" && <HomePage onNavigate={setPage} />}
      {page === "games" && <GamesPage onBack={goHome} />}
      {page === "apps" && <AppsPage onBack={goHome} />}
      {page === "files" && <FilesPage onBack={goHome} />}
      {page === "settings" && <SettingsPage onBack={goHome} />}
    </div>
  );
}
