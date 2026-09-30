import { ToolboxPanel } from "./ToolboxPanel";

type Props = { focusGameId?: string };

/** Toolbox as a main-window tab. The game card menu jumps here with a game preselected. */
export function ToolboxPage({ focusGameId }: Props) {
  return (
    <main className="page library-page">
      <div className="toolbox-page-body">
        <ToolboxPanel active focusGameId={focusGameId} />
      </div>
    </main>
  );
}
