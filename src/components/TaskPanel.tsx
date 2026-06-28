import { useEffect, useState, type CSSProperties } from "react";
import { fetchMyTasks, loadToken, saveToken, type ClickUpTask } from "../lib/clickup";
import { groupAndSortTasks } from "../lib/format";
import { toMessage } from "../lib/errors";
import { StatusGroup } from "./StatusGroup";
import { TaskDrawer } from "./TaskDrawer";
import { colors, radius, space } from "./ui";

/**
 * Read-only side panel of the ClickUp tasks assigned to the user, grouped by status.
 * Owns its own state so fetching never interferes with the whiteboard toolbar.
 */
export type RightView = "agent" | "board" | "queue";

export function TaskPanel({
  view,
  onSelectView,
}: {
  view: RightView;
  onSelectView: (v: RightView) => void;
}) {
  const [tasks, setTasks] = useState<ClickUpTask[]>([]);
  const [token, setToken] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ClickUpTask | null>(null);
  const [openSeq, setOpenSeq] = useState(0); // bump on each open so re-opening always remounts the drawer
  const openTask = (t: ClickUpTask) => {
    setSelected(t);
    setOpenSeq((s) => s + 1);
  };

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

  const groups = groupAndSortTasks(tasks);

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <img
          src="/app-icon.png"
          alt=""
          width={22}
          height={22}
          style={{ borderRadius: 6, flexShrink: 0 }}
        />
        <strong style={{ fontSize: 14, color: colors.text }}>My ClickUp Tasks</strong>
        <span style={{ flex: 1 }} />
        <button onClick={refresh} disabled={loading} title="Refresh" aria-label="Refresh" style={iconBtnStyle}>
          {loading ? "…" : "↻"}
        </button>
        <button
          onClick={() => setShowSettings((v) => !v)}
          title="Settings"
          aria-label="Settings"
          style={iconBtnStyle}
        >
          ⚙
        </button>
      </div>

      {showSettings && (
        <div style={settingsStyle}>
          <label style={{ fontSize: 12, color: colors.textMuted }}>ClickUp personal token</label>
          <input
            type="password"
            style={inputStyle}
            value={token}
            placeholder="pk_..."
            onChange={(e) => setToken(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveAndRefresh();
            }}
          />
          <button onClick={saveAndRefresh} disabled={loading || !token.trim()} className="primary" style={saveBtnStyle}>
            Save &amp; Refresh
          </button>
        </div>
      )}

      {error && <div style={errorStyle}>{error}</div>}

      <div style={tabBarStyle}>
        <button style={tabBtnStyle(view === "agent")} onClick={() => onSelectView("agent")}>
          ✨ Claude Code
        </button>
        <button style={tabBtnStyle(view === "board")} onClick={() => onSelectView("board")}>
          ▦ Board
        </button>
        <button style={tabBtnStyle(view === "queue")} onClick={() => onSelectView("queue")}>
          ⚡ Queue
        </button>
      </div>

      <div style={listStyle}>
        {loading && tasks.length === 0 && (
          <div style={{ padding: space(3) }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ ...skeletonRow, opacity: 1 - i * 0.18 }} />
            ))}
          </div>
        )}
        {!loading && !error && tasks.length === 0 && (
          <div style={{ padding: space(4), fontSize: 13, color: colors.textFaint }}>No tasks assigned to you.</div>
        )}
        {groups.map((g) => (
          <StatusGroup
            key={g.status}
            group={g}
            defaultOpen={g.status.toLowerCase().includes("progress")}
            onOpen={openTask}
          />
        ))}
      </div>

      {selected && (
        <TaskDrawer
          key={`${selected.id}:${openSeq}`}
          task={selected}
          onClose={() => setSelected(null)}
          onTaskUpdated={(u) => setTasks((ts) => ts.map((t) => (t.id === u.id ? u : t)))}
        />
      )}
    </div>
  );
}

const panelStyle: CSSProperties = {
  width: "20vw",
  minWidth: 260,
  flexShrink: 0,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  borderRight: `1px solid ${colors.border}`,
  background: colors.bg,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(1.5),
  padding: `${space(3)}px ${space(4)}px`,
  borderBottom: `1px solid ${colors.border}`,
  background: colors.surface,
};

const iconBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${colors.border}`,
  background: colors.surface,
  borderRadius: radius.sm,
  width: 30,
  height: 30,
  cursor: "pointer",
  color: colors.textMuted,
  fontSize: 15,
  lineHeight: 1,
};

const tabBarStyle: CSSProperties = {
  display: "flex",
  gap: space(1),
  padding: `${space(1.5)}px ${space(3)}px 0`,
  borderBottom: `1px solid ${colors.border}`,
  background: colors.surface,
};

const tabBtnStyle = (active: boolean): CSSProperties => ({
  flex: 1,
  border: "none",
  background: "transparent",
  padding: `${space(2)}px ${space(1)}px`,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  color: active ? colors.accent : colors.textMuted,
  borderBottom: `2px solid ${active ? colors.accent : "transparent"}`,
  marginBottom: -1,
});

const settingsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space(2),
  padding: space(4),
  borderBottom: `1px solid ${colors.border}`,
  background: colors.surface,
};

const inputStyle: CSSProperties = {
  padding: `${space(2)}px ${space(2.5)}px`,
  fontSize: 13,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  outline: "none",
};

const saveBtnStyle: CSSProperties = {
  padding: `${space(2)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const errorStyle: CSSProperties = {
  padding: `${space(2.5)}px ${space(4)}px`,
  fontSize: 13,
  color: colors.danger,
  borderBottom: `1px solid ${colors.border}`,
  background: "#fdecec",
};

const listStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: `${space(2)}px ${space(1.5)}px`,
};

const skeletonRow: CSSProperties = {
  height: 40,
  borderRadius: radius.sm,
  background: `linear-gradient(90deg, ${colors.surfaceAlt}, #e9ecf3, ${colors.surfaceAlt})`,
  marginBottom: space(2),
};
