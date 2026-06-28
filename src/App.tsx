// Excalidraw's stylesheet must load globally — the per-task boards in the drawer render it.
import "@excalidraw/excalidraw/index.css";
import { useState } from "react";
import { TaskPanel, type RightView } from "./components/TaskPanel";
import { AgentPanel } from "./components/AgentPanel";
import { TaskBoard } from "./components/TaskBoard";
import { QueuePanel } from "./components/QueuePanel";
import "./App.css";

// Left: the ClickUp task sidebar. Right: Claude Code, the task board, or the Claude queue
// (selected from the sidebar's tab bar). Each right view is lazy-mounted, then kept alive so
// its state (chat session, board, running queue) survives switching away.
function App() {
  const [view, setView] = useState<RightView>("agent");
  const [seen, setSeen] = useState<Record<RightView, boolean>>({
    agent: true,
    board: false,
    queue: false,
  });

  function selectView(v: RightView) {
    setSeen((s) => (s[v] ? s : { ...s, [v]: true }));
    setView(v);
  }

  const pane = (v: RightView): React.CSSProperties => ({
    flex: 1,
    minHeight: 0,
    display: view === v ? "flex" : "none",
    flexDirection: "column",
  });

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex" }}>
      <TaskPanel view={view} onSelectView={selectView} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* Claude Code is always mounted (its session survives) — just hidden under other views. */}
        <div style={pane("agent")}>
          <AgentPanel />
        </div>
        {seen.board && (
          <div style={pane("board")}>
            <TaskBoard />
          </div>
        )}
        {seen.queue && (
          <div style={pane("queue")}>
            <QueuePanel />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
