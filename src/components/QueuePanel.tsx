import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  fetchMyTasks,
  fetchTaskDetail,
  parseTaskId,
  type ClickUpTask,
} from "../lib/clickup";
import {
  AGENT_EFFORT_KEY as EFFORT_KEY,
  AGENT_FOLDER_KEY,
  AGENT_MODEL_KEY as MODEL_KEY,
  AGENT_PERM_KEY,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PERM_OPTIONS,
  getAgentFolder,
  getAgentPermission,
  toolLabel,
  type PermissionMode,
  type Transcript,
} from "../lib/agent";
import { DEFAULT_BASE_PROMPT, type QueueConfig, type QueueItem } from "../lib/queue";
import { useQueue } from "../hooks/useQueue";
import { renderMarkdown } from "../lib/markdown";
import { toMessage } from "../lib/errors";
import { colors, radius, space, solidBadgeBg } from "./ui";

// Queue-specific config keys. Folder/permission/model/effort keys + the option arrays are
// shared with the Claude Code panel (imported from ../lib/agent).
const VERIFY_KEY = "cu-queue-verify";
const STATUS_PROGRESS_KEY = "cu-queue-status-progress";
const STATUS_DONE_KEY = "cu-queue-status-done";

const STATE_BADGE: Record<QueueItem["state"], { label: string; bg: string }> = {
  pending: { label: "Pending", bg: colors.textFaint },
  running: { label: "Working…", bg: "#f59e0b" },
  verifying: { label: "Verifying…", bg: "#3b82f6" },
  succeeded: { label: "Done ✓", bg: "#16a34a" },
  failed: { label: "Failed", bg: colors.danger },
};

/**
 * The Claude Queue: pick tickets, then let the embedded agent implement + verify each one in
 * the work folder, sequentially, halting on the first failure and writing status + a summary
 * comment back to ClickUp.
 */
export function QueuePanel() {
  const q = useQueue();

  const [folder, setFolder] = useState(() => getAgentFolder());
  const [perm, setPerm] = useState<PermissionMode>(() => getAgentPermission());
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
  const [effort, setEffort] = useState(() => localStorage.getItem(EFFORT_KEY) ?? "");
  const [verify, setVerify] = useState(() => localStorage.getItem(VERIFY_KEY) ?? "");
  const [inProg, setInProg] = useState(() => localStorage.getItem(STATUS_PROGRESS_KEY) ?? "");
  const [doneStatus, setDoneStatus] = useState(() => localStorage.getItem(STATUS_DONE_KEY) ?? "");

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTasks, setPickerTasks] = useState<ClickUpTask[] | null>(null);
  const [query, setQuery] = useState("");
  const [paste, setPaste] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const addWrapRef = useRef<HTMLDivElement>(null);

  const persist = (key: string, v: string) => {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* ignore */
    }
  };

  async function pickFolder() {
    const picked = await open({ directory: true });
    if (typeof picked === "string") {
      setFolder(picked);
      persist(AGENT_FOLDER_KEY, picked);
    }
  }

  function updatePerm(v: PermissionMode) {
    if (
      v === "full" &&
      !window.confirm("Full mode lets the agent run ANY command in this folder without asking. Continue?")
    ) {
      return;
    }
    setPerm(v);
    persist(AGENT_PERM_KEY, v);
  }

  // Close the picker on Escape / outside click (mirrors TaskBoard).
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addWrapRef.current && !addWrapRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  async function openPicker() {
    setPickerOpen(true);
    if (pickerTasks === null) {
      try {
        setPickerTasks(await fetchMyTasks());
      } catch (e) {
        setAddError(toMessage(e));
        setPickerTasks([]);
      }
    }
  }

  async function addByPaste() {
    const id = parseTaskId(paste);
    if (!id) return;
    setAddError(null);
    try {
      q.add([await fetchTaskDetail(id)]);
      setPaste("");
    } catch {
      setAddError("Couldn't find that task — check the ClickUp link or id.");
    }
  }

  function startQueue() {
    const config: QueueConfig = {
      cwd: folder,
      permissionMode: perm,
      model,
      effort,
      verifyCommand: verify,
      inProgressStatus: inProg,
      doneStatus,
      basePrompt: DEFAULT_BASE_PROMPT,
    };
    void q.start(config);
  }

  const inQueue = new Set(q.items.map((i) => i.task.id));
  const matches =
    pickerTasks?.filter((t) => t.name.toLowerCase().includes(query.toLowerCase())).slice(0, 50) ?? [];
  const pendingCount = q.items.filter((i) => i.state === "pending").length;
  const canStart = !q.running && folder.trim().length > 0 && pendingCount > 0;

  return (
    <div style={wrapStyle}>
      <div style={toolbarStyle}>
        <strong style={{ fontSize: 13, color: colors.text }}>Claude Queue</strong>
        <span style={{ fontSize: 11.5, color: colors.textFaint }}>
          {q.items.length} ticket{q.items.length === 1 ? "" : "s"} · {pendingCount} pending
        </span>
        <span style={{ flex: 1 }} />
        {q.running ? (
          <button onClick={q.stop} style={stopBtnStyle}>
            ■ Stop
          </button>
        ) : (
          <button onClick={startQueue} disabled={!canStart} className="primary" style={primaryBtnStyle}>
            ▶ Start
          </button>
        )}
        <button onClick={q.clearSucceeded} disabled={q.running} style={ghostBtnStyle} title="Remove completed tickets">
          Clear done
        </button>
        <button onClick={q.clear} disabled={q.running} style={ghostBtnStyle} title="Empty the queue">
          Clear all
        </button>
      </div>

      {/* Config */}
      <div style={configStyle}>
        <button onClick={pickFolder} style={folderBtnStyle} title={folder || "No folder set"}>
          📁 {folder ? shortPath(folder) : "Set work folder…"}
        </button>
        <select value={perm} onChange={(e) => updatePerm(e.currentTarget.value as PermissionMode)} style={selectStyle}>
          {PERM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={model}
          onChange={(e) => {
            setModel(e.currentTarget.value);
            persist(MODEL_KEY, e.currentTarget.value);
          }}
          style={selectStyle}
        >
          {MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={effort}
          onChange={(e) => {
            setEffort(e.currentTarget.value);
            persist(EFFORT_KEY, e.currentTarget.value);
          }}
          style={selectStyle}
        >
          {EFFORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          style={inputStyle}
          value={verify}
          placeholder="Verify command, e.g. npm test"
          onChange={(e) => {
            setVerify(e.currentTarget.value);
            persist(VERIFY_KEY, e.currentTarget.value);
          }}
        />
        <input
          style={statusInputStyle}
          value={inProg}
          placeholder="In-progress status"
          onChange={(e) => {
            setInProg(e.currentTarget.value);
            persist(STATUS_PROGRESS_KEY, e.currentTarget.value);
          }}
        />
        <input
          style={statusInputStyle}
          value={doneStatus}
          placeholder="Done status"
          onChange={(e) => {
            setDoneStatus(e.currentTarget.value);
            persist(STATUS_DONE_KEY, e.currentTarget.value);
          }}
        />
      </div>

      <div style={warnStyle}>
        ⚠️ Start runs Claude <strong>unattended</strong> — it edits files and runs commands in the work
        folder, then verifies. The queue <strong>halts on the first failure</strong>.
        {!verify.trim() && (
          <span style={{ display: "block", marginTop: 2 }}>
            No verify command set — tickets will be marked done <strong>without a test gate</strong>.
          </span>
        )}
      </div>

      {/* Add tickets */}
      <div style={addRowStyle}>
        <div ref={addWrapRef} style={{ position: "relative" }}>
          <button onClick={openPicker} style={addBtnStyle} disabled={q.running}>
            + Add ticket
          </button>
          {pickerOpen && (
            <div style={pickerStyle}>
              <input
                autoFocus
                style={pickerSearchStyle}
                value={query}
                placeholder="Search your tasks…"
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              <div style={{ overflowY: "auto", maxHeight: 260, marginTop: space(2) }}>
                {pickerTasks === null ? (
                  <div style={pickerEmptyStyle}>Loading…</div>
                ) : matches.length === 0 ? (
                  <div style={pickerEmptyStyle}>No matching tasks.</div>
                ) : (
                  matches.map((t) => {
                    const added = inQueue.has(t.id);
                    return (
                      <button
                        key={t.id}
                        disabled={added}
                        onClick={() => {
                          q.add([t]);
                          setPickerOpen(false);
                        }}
                        style={{ ...pickerItemStyle, opacity: added ? 0.45 : 1 }}
                      >
                        <span style={{ ...dotStyle, background: solidBadgeBg(t.statusColor) }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.name}
                        </span>
                        {added && <span style={{ marginLeft: "auto", fontSize: 11, color: colors.textFaint }}>added</span>}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
        <input
          style={pasteStyle}
          value={paste}
          placeholder="Paste a ClickUp link or id…"
          disabled={q.running}
          onChange={(e) => setPaste(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addByPaste();
          }}
        />
        {q.halt && (
          <button onClick={q.resetFailed} style={ghostBtnStyle} title="Reset failed tickets to pending">
            Retry failed
          </button>
        )}
      </div>

      {addError && <div style={errorStyle}>{addError}</div>}
      {q.halt && (
        <div style={haltStyle}>
          ⛔ Queue halted at “{q.halt.taskName}”: {q.halt.error}
        </div>
      )}

      {/* Queue list */}
      <div style={listStyle}>
        {q.items.length === 0 ? (
          <div style={emptyStyle}>
            Queue is empty. <strong>+ Add ticket</strong> or paste a ClickUp link, set a work folder and a
            verify command, then <strong>Start</strong>.
          </div>
        ) : (
          q.items.map((item) => {
            const badge = STATE_BADGE[item.state];
            const isOpen = expanded === item.task.id || item.state === "running" || item.state === "verifying";
            return (
              <div key={item.task.id} style={rowStyle}>
                <div
                  style={rowHeadStyle}
                  onClick={() => setExpanded((e) => (e === item.task.id ? null : item.task.id))}
                >
                  <span style={{ ...badgeStyle, background: badge.bg }}>{badge.label}</span>
                  <span style={rowTitleStyle}>{item.task.name}</span>
                  {!q.running && (
                    <button
                      data-no-row
                      onClick={(e) => {
                        e.stopPropagation();
                        q.remove(item.task.id);
                      }}
                      style={removeBtnStyle}
                      title="Remove from queue"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {item.error && <div style={rowErrorStyle}>{item.error}</div>}
                {isOpen && <TranscriptView transcript={item.transcript} summary={item.summary} />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function TranscriptView({ transcript, summary }: { transcript?: Transcript; summary?: string }) {
  const hasTranscript = transcript && transcript.length > 0;
  if (!hasTranscript && !summary) return null;
  return (
    <div style={transcriptStyle}>
      {transcript?.map((t, i) => {
        if (t.role !== "assistant") return null;
        const text = t.text || t.streamingText || "";
        return (
          <div key={i}>
            {t.tools.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 6 }}>
                {t.tools.map((tool, j) => (
                  <div key={j} style={toolRowStyle}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {toolLabel(tool.name, tool.inputPreview)}
                    </span>
                    {tool.isError && <span style={{ color: colors.danger, flexShrink: 0 }}>✕</span>}
                  </div>
                ))}
              </div>
            )}
            {text && (
              <div
                className="cu-markdown"
                style={{ fontSize: 12.5 }}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
}

const wrapStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: colors.bg,
};
const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  padding: `${space(2.5)}px ${space(4)}px`,
  borderBottom: `1px solid ${colors.border}`,
  background: colors.surface,
};
const configStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: space(2),
  padding: `${space(2.5)}px ${space(4)}px`,
  borderBottom: `1px solid ${colors.border}`,
  background: colors.surfaceAlt,
};
const baseControl: CSSProperties = {
  height: 30,
  boxSizing: "border-box",
  padding: `0 ${space(2)}px`,
  fontSize: 12.5,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  background: colors.surface,
  outline: "none",
  color: colors.text,
};
const folderBtnStyle: CSSProperties = { ...baseControl, cursor: "pointer", maxWidth: 220, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" };
const selectStyle: CSSProperties = { ...baseControl, cursor: "pointer" };
const inputStyle: CSSProperties = { ...baseControl, flex: 1, minWidth: 150 };
const statusInputStyle: CSSProperties = { ...baseControl, width: 140 };
const warnStyle: CSSProperties = {
  padding: `${space(2)}px ${space(4)}px`,
  fontSize: 12,
  color: "#92400e",
  background: "#fffbeb",
  borderBottom: `1px solid ${colors.border}`,
};
const addRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  padding: `${space(2.5)}px ${space(4)}px`,
  borderBottom: `1px solid ${colors.border}`,
};
const primaryBtnStyle: CSSProperties = {
  padding: `${space(1.5)}px ${space(3)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const stopBtnStyle: CSSProperties = {
  padding: `${space(1.5)}px ${space(3)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  color: "#fff",
  background: colors.danger,
  border: "none",
  borderRadius: radius.sm,
};
const ghostBtnStyle: CSSProperties = {
  padding: `${space(1.5)}px ${space(2.5)}px`,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  color: colors.textMuted,
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
};
const addBtnStyle: CSSProperties = {
  padding: `${space(1.5)}px ${space(3)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  color: colors.accent,
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
};
const pasteStyle: CSSProperties = { ...baseControl, flex: 1, minWidth: 0 };
const pickerStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  zIndex: 20,
  width: 340,
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  boxShadow: colors.shadow,
  padding: space(2),
};
const pickerSearchStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${space(2)}px ${space(2.5)}px`,
  fontSize: 13,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  outline: "none",
};
const pickerItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  width: "100%",
  textAlign: "left",
  border: "none",
  background: "transparent",
  borderRadius: radius.sm,
  padding: `${space(1.5)}px ${space(2)}px`,
  fontSize: 13,
  color: colors.text,
  cursor: "pointer",
};
const pickerEmptyStyle: CSSProperties = { padding: space(3), fontSize: 13, color: colors.textFaint };
const dotStyle: CSSProperties = { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 };
const listStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: space(3),
  display: "flex",
  flexDirection: "column",
  gap: space(2),
};
const emptyStyle: CSSProperties = { fontSize: 13.5, lineHeight: 1.6, color: colors.textFaint, padding: space(3) };
const rowStyle: CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  background: colors.surface,
  overflow: "hidden",
};
const rowHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  padding: `${space(2)}px ${space(2.5)}px`,
  cursor: "pointer",
};
const badgeStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: "#fff",
  padding: "2px 8px",
  borderRadius: radius.pill,
  whiteSpace: "nowrap",
  flexShrink: 0,
};
const rowTitleStyle: CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontWeight: 600,
  color: colors.text,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const removeBtnStyle: CSSProperties = {
  flexShrink: 0,
  width: 22,
  height: 22,
  border: "none",
  background: "transparent",
  color: colors.textFaint,
  cursor: "pointer",
  borderRadius: radius.sm,
  fontSize: 12,
};
const rowErrorStyle: CSSProperties = {
  padding: `${space(1.5)}px ${space(2.5)}px`,
  fontSize: 12,
  color: colors.danger,
  background: "#fdecec",
  whiteSpace: "pre-wrap",
};
const transcriptStyle: CSSProperties = {
  padding: `${space(2)}px ${space(2.5)}px`,
  borderTop: `1px solid ${colors.border}`,
  background: colors.surfaceAlt,
  maxHeight: 320,
  overflowY: "auto",
};
const toolRowStyle: CSSProperties = {
  display: "flex",
  gap: space(1),
  fontSize: 11.5,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: colors.textMuted,
};
const errorStyle: CSSProperties = {
  padding: `${space(2)}px ${space(4)}px`,
  fontSize: 13,
  color: colors.danger,
  background: "#fdecec",
  borderBottom: `1px solid ${colors.border}`,
};
const haltStyle: CSSProperties = {
  padding: `${space(2)}px ${space(4)}px`,
  fontSize: 12.5,
  color: "#92400e",
  background: "#fffbeb",
  borderBottom: `1px solid ${colors.border}`,
};
