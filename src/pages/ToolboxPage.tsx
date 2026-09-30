import { ToolboxPanel } from "./ToolboxPanel";

/** Toolbox as a main-window tab: runtimes only. Per-game tools live on the game card menu. */
export function ToolboxPage() {
  return (
    <main className="page library-page">
      <div className="toolbox-page-body">
        <ToolboxPanel />
      </div>
    </main>
  );
}
