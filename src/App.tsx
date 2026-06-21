import { useState, type CSSProperties } from "react";
import { Excalidraw, exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { invoke } from "@tauri-apps/api/core";
import { generateDiagram } from "./lib/claude";
import { diagramToElements } from "./lib/toExcalidraw";
import { TaskPanel } from "./components/TaskPanel";
import "./App.css";

function App() {
  // Excalidraw's imperative API handle. Typed loosely to avoid version-specific type-path imports.
  const [api, setApi] = useState<any>(null);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState(true);

  function report(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
  }

  // Run one toolbar action at a time: clears banners, sets the busy flag, reports errors.
  // The single `loading` flag (which disables every control) keeps handlers from racing.
  async function run(action: () => Promise<void>) {
    if (!api || loading) return;
    setError(null);
    setStatus(null);
    setLoading(true);
    try {
      await action();
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  }

  // Put elements on the canvas and frame them in view.
  function showScene(elements: any) {
    api.updateScene({ elements });
    if (elements.length) {
      api.scrollToContent(elements, { fitToContent: true });
    }
  }

  function handleGenerate() {
    if (!prompt.trim()) return;
    run(async () => {
      const diagram = await generateDiagram(prompt);
      showScene(diagramToElements(diagram));
    });
  }

  function handleSave() {
    run(async () => {
      // serializeAsJSON captures elements + appState + embedded image files (the
      // standard .excalidraw format), so a saved scene survives a full round-trip.
      const json = serializeAsJSON(
        api.getSceneElements(),
        api.getAppState(),
        api.getFiles(),
        "local",
      );
      const path = await invoke<string>("save_scene", { json });
      setStatus(`Saved to ${path}`);
    });
  }

  function handleLoad() {
    run(async () => {
      const scene = JSON.parse(await invoke<string>("load_scene"));
      const files = scene.files ?? {};
      if (Object.keys(files).length) {
        api.addFiles(Object.values(files)); // restore embedded images before rendering
      }
      showScene(scene.elements ?? []);
      setStatus("Loaded saved scene");
    });
  }

  function handleExport() {
    run(async () => {
      const elements = api.getSceneElements();
      if (!elements.length) {
        setStatus("Nothing to export yet — generate or draw something first");
        return;
      }
      const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        mimeType: "image/png",
      });
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const path = await invoke<string>("save_png", { bytes });
      setStatus(`Exported PNG to ${path}`);
    });
  }

  // Layout: a normal-flow toolbar (and optional banner) stacked above Excalidraw, which
  // fills the remaining height. The toolbar is NOT overlaid on the canvas, so it never
  // covers Excalidraw's own menu/tool UI.
  return (
    <div style={appStyle}>
      <div className="app-toolbar" style={toolbarStyle}>
        <input
          style={{ flex: 1, padding: "8px 10px", fontSize: 14 }}
          value={prompt}
          placeholder='Describe a diagram, e.g. "flowchart for user login"'
          onChange={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleGenerate();
          }}
          disabled={loading}
        />
        <button onClick={handleGenerate} disabled={loading || !api || !prompt.trim()}>
          {loading ? "Working…" : "Generate"}
        </button>
        <button onClick={handleSave} disabled={loading || !api}>
          Save
        </button>
        <button onClick={handleLoad} disabled={loading || !api}>
          Load
        </button>
        <button onClick={handleExport} disabled={loading || !api}>
          Export PNG
        </button>
        <button onClick={() => setShowTasks((v) => !v)}>
          {showTasks ? "Hide Tasks" : "Show Tasks"}
        </button>
      </div>

      {(error || status) && (
        <div style={{ ...bannerStyle, color: error ? "crimson" : "#2563eb" }}>
          {error ?? status}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {showTasks && <TaskPanel />}
        <div style={canvasWrapStyle}>
          <Excalidraw excalidrawAPI={(a) => setApi(a)} />
        </div>
      </div>
    </div>
  );
}

const appStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100vw",
  height: "100vh",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: 12,
  borderBottom: "1px solid #e5e5e5",
  background: "#fafafa",
};

const bannerStyle: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  borderBottom: "1px solid #eee",
  background: "#ffffff",
};

// flex:1 gives Excalidraw a concrete height; minHeight:0 lets it shrink within the column.
const canvasWrapStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: "relative",
};

export default App;
