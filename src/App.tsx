// Excalidraw's stylesheet must load globally — the per-task boards in the drawer render it.
import "@excalidraw/excalidraw/index.css";
import { useState } from "react";
import { TaskPanel } from "./components/TaskPanel";
import { AgentPanel } from "./components/AgentPanel";
import { TaskBoard } from "./components/TaskBoard";
import "./App.css";

// Left: the ClickUp task sidebar. Right: Claude Code, or the task board (toggled from the sidebar).
function App() {
  const [showBoard, setShowBoard] = useState(false);
  const [boardSeen, setBoardSeen] = useState(false); // lazy-mount the board, then keep it alive

  function toggleBoard() {
    setShowBoard((b) => {
      if (!b) setBoardSeen(true);
      return !b;
    });
  }

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex" }}>
      <TaskPanel boardActive={showBoard} onToggleBoard={toggleBoard} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* Keep Claude Code mounted (its session survives) — just hide it under the board. */}
        <div style={{ flex: 1, minHeight: 0, display: showBoard ? "none" : "flex", flexDirection: "column" }}>
          <AgentPanel />
        </div>
        {boardSeen && (
          <div style={{ flex: 1, minHeight: 0, display: showBoard ? "flex" : "none", flexDirection: "column" }}>
            <TaskBoard />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
