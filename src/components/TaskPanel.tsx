import { useEffect, useState, type CSSProperties } from "react";
import {
  fetchMyTasks,
  loadToken,
  saveToken,
  type ClickUpTask,
} from "../lib/clickup";

/** Extract a human-readable message from a thrown value (Tauri rejects with strings). */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A read-only side panel listing the ClickUp tasks assigned to the user.
 * It owns all of its state (tasks, token, loading, error) so fetching never
 * interferes with the whiteboard toolbar in App.tsx, and vice-versa.
 */
export function TaskPanel() {
  const [tasks, setTasks] = useState<ClickUpTask[]>([]);
  const [token, setToken] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setTasks(await fetchMyTasks());
    } catch (e) {
      setTasks([]); // don't leave a stale list under the error banner
      setError(toMessage(e));
    } finally {
      setLoading(false);
    }
  }

  // On mount, load the saved token; auto-fetch if one is already present.
  useEffect(() => {
    loadToken()
      .then((t) => {
        setToken(t);
        if (t.trim()) refresh();
        else setShowSettings(true); // no token yet → reveal the settings field
      })
      .catch((e) => setError(toMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveAndRefresh() {
    if (loading) return; // guard against double-submit during the save round-trip
    setLoading(true); // covers the saveToken phase; refresh() keeps it set through the fetch
    setError(null);
    try {
      await saveToken(token);
    } catch (e) {
      setError(toMessage(e));
      setLoading(false);
      return;
    }
    setShowSettings(false);
    await refresh();
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <strong style={{ fontSize: 14 }}>My ClickUp Tasks</strong>
        <span style={{ flex: 1 }} />
        <button onClick={refresh} disabled={loading} title="Refresh">
          {loading ? "…" : "↻"}
        </button>
        <button
          onClick={() => setShowSettings((v) => !v)}
          title="Settings"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>

      {showSettings && (
        <div style={settingsStyle}>
          <label style={{ fontSize: 12, color: "#555" }}>
            ClickUp personal token
          </label>
          <input
            type="password"
            style={{ padding: "6px 8px", fontSize: 13 }}
            value={token}
            placeholder="pk_..."
            onChange={(e) => setToken(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveAndRefresh();
            }}
          />
          <button onClick={saveAndRefresh} disabled={loading || !token.trim()}>
            Save &amp; Refresh
          </button>
        </div>
      )}

      {error && <div style={errorStyle}>{error}</div>}

      <div style={listStyle}>
        {!loading && !error && tasks.length === 0 && (
          <div style={{ padding: 12, fontSize: 13, color: "#777" }}>
            No tasks assigned to you.
          </div>
        )}
        {tasks.map((t) => (
          <div key={t.id} style={rowStyle}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t.name}</div>
            <div style={metaStyle}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: t.statusColor || "#999",
                  display: "inline-block",
                }}
              />
              <span>{t.status || "—"}</span>
              <span style={{ color: "#bbb" }}>·</span>
              <span>
                {t.dueDate
                  ? new Date(Number(t.dueDate)).toLocaleDateString()
                  : "No due date"}
              </span>
            </div>
            {t.listName && <div style={subtextStyle}>{t.listName}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

const panelStyle: CSSProperties = {
  width: 300,
  flexShrink: 0,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid #e5e5e5",
  background: "#fafafa",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "10px 12px",
  borderBottom: "1px solid #e5e5e5",
};

const settingsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 12,
  borderBottom: "1px solid #eee",
  background: "#fff",
};

const errorStyle: CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  color: "crimson",
  borderBottom: "1px solid #eee",
};

const listStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "10px 12px",
  borderBottom: "1px solid #eee",
};

const metaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "#555",
};

const subtextStyle: CSSProperties = {
  fontSize: 11,
  color: "#999",
};
