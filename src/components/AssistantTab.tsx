import { useEffect, useRef, useState, type CSSProperties } from "react";
import { renderMarkdown } from "../lib/markdown";
import { toMessage } from "../lib/errors";
import {
  askClaude,
  buildSystemPrompt,
  buildUserPrompt,
  claudeStatus,
  claudeTestConnection,
  type AssistantAction,
  type ChatTurn,
  type ClaudeStatus,
} from "../lib/assistant";
import {
  addComment,
  createSubtask,
  fetchListStatuses,
  PRIORITY_INT,
  setDueDate,
  setPriority,
  setStatus,
  type ClickUpTask,
  type Comment,
} from "../lib/clickup";
import { colors, radius, space } from "./ui";

const SUCCESS = "#10b981";
const todayISO = () => new Date().toISOString().slice(0, 10);

type CardState = { status: "idle" | "applying" | "done" | "dismissed" | "error"; message?: string };
type Msg = { role: "user" | "assistant"; text: string; actions?: AssistantAction[] };

/**
 * Per-ticket Claude chat. Claude gets the ticket context + transcript each turn and may
 * propose write-actions, which render as Apply/Dismiss cards. Only an explicit Apply calls
 * ClickUp; on success it refreshes the drawer via `onApplied`.
 */
export function AssistantTab({
  task,
  detail,
  comments,
  onApplied,
}: {
  task: ClickUpTask;
  detail: ClickUpTask | null;
  comments: Comment[];
  onApplied: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatusState] = useState<ClaudeStatus | null>(null);
  const [conn, setConn] = useState<{ testing: boolean; ok?: boolean; detail?: string }>({ testing: false });
  const [cards, setCards] = useState<Record<string, CardState>>({}); // key = `${msgIndex}:${actionIndex}`
  const statusesRef = useRef<string[] | undefined>(undefined);
  const applying = useRef<Set<string>>(new Set());
  const composing = useRef(false); // true mid-IME-composition (WebKitGTK can report isComposing=false on the commit key)
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    claudeStatus().then(setStatusState).catch(() => {});
  }, []);

  // Best-effort: fetch the list's valid statuses so the assistant proposes real ones.
  useEffect(() => {
    const lid = detail?.listId ?? task.listId;
    if (!lid) return;
    let cancelled = false;
    fetchListStatuses(lid)
      .then((s) => {
        if (!cancelled) statusesRef.current = s;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [detail?.listId, task.listId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    setInput("");
    const history: ChatTurn[] = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((m) => [...m, { role: "user", text }]);
    setSending(true);
    try {
      const system = buildSystemPrompt(task, detail, comments, todayISO(), statusesRef.current);
      const prompt = buildUserPrompt(history, text);
      const reply = await askClaude(system, prompt);
      setMessages((m) => [...m, { role: "assistant", text: reply.reply || "_(no reply)_", actions: reply.actions }]);
    } catch (e) {
      setError(toMessage(e));
      // Roll back the un-answered user turn and restore the text, so a retry doesn't
      // leave two consecutive user turns in the transcript sent to Claude.
      setMessages((m) => (m.length && m[m.length - 1].role === "user" ? m.slice(0, -1) : m));
      setInput(text);
    } finally {
      setSending(false);
    }
  }

  async function applyAction(key: string, action: AssistantAction) {
    if (applying.current.has(key)) return; // guard a double-click landing before the re-render disables the button
    applying.current.add(key);
    setCards((c) => ({ ...c, [key]: { status: "applying" } }));
    try {
      switch (action.type) {
        case "comment":
          await addComment(task.id, action.text);
          break;
        case "set_status": {
          // Resolve to the list's exact status casing; reject an unknown status with a clear message
          // (better than ClickUp's generic 400) when we know the valid set.
          let status = action.status;
          const valid = statusesRef.current;
          if (valid && valid.length) {
            const match = valid.find((s) => s.toLowerCase() === status.toLowerCase());
            if (!match) throw new Error(`"${status}" isn't a status in this list. Valid: ${valid.join(", ")}`);
            status = match;
          }
          await setStatus(task.id, status);
          break;
        }
        case "set_priority":
          await setPriority(task.id, PRIORITY_INT[action.priority]);
          break;
        case "set_due_date": {
          // Parse YYYY-MM-DD at LOCAL noon so the day never shifts across timezones — a date-only
          // string parses as UTC midnight, which lands a day early for users west of UTC.
          const ms = new Date(`${action.date}T12:00:00`).getTime();
          if (Number.isNaN(ms)) throw new Error(`Invalid date: ${action.date}`);
          await setDueDate(task.id, ms);
          break;
        }
        case "create_subtask": {
          const lid = detail?.listId ?? task.listId;
          if (!lid) throw new Error("This ticket has no list id, so a subtask can't be created.");
          await createSubtask(lid, task.id, action.name, action.description);
          break;
        }
      }
      setCards((c) => ({ ...c, [key]: { status: "done" } }));
      onApplied();
    } catch (e) {
      setCards((c) => ({ ...c, [key]: { status: "error", message: toMessage(e) } }));
    } finally {
      applying.current.delete(key);
    }
  }

  function dismiss(key: string) {
    setCards((c) => ({ ...c, [key]: { status: "dismissed" } }));
  }

  async function checkConnection() {
    setConn({ testing: true });
    try {
      const r = await claudeTestConnection();
      setConn({ testing: false, ok: r.ok, detail: r.detail });
    } catch (e) {
      setConn({ testing: false, ok: false, detail: toMessage(e) });
    }
  }

  return (
    <div style={wrapStyle}>
      <div style={badgeRowStyle}>
        <ClaudeBadge status={status} connOk={conn.ok} />
        <span style={{ flex: 1 }} />
        <button style={smallBtnStyle} disabled={conn.testing} onClick={checkConnection}>
          {conn.testing ? "Checking…" : "Check connection"}
        </button>
      </div>
      {conn.detail && conn.ok === false && <div style={errStyle}>{conn.detail}</div>}

      <div ref={scrollRef} style={scrollStyle}>
        {messages.length === 0 && (
          <div style={emptyStyle}>
            Ask Claude about this ticket — e.g. “summarize this and suggest subtasks”, or “draft a
            reply comment”. Claude can propose changes (comment, status, subtask…) that you approve
            before anything is written to ClickUp.
          </div>
        )}
        {messages.map((m, mi) =>
          m.role === "user" ? (
            <div key={mi} style={userBubbleStyle}>
              {m.text}
            </div>
          ) : (
            <div key={mi}>
              <div
                className="cu-markdown"
                style={asstBubbleStyle}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
              />
              {m.actions && m.actions.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: space(2), margin: `${space(2)}px 0` }}>
                  {m.actions.map((a, ai) => {
                    const key = `${mi}:${ai}`;
                    return (
                      <ActionCard
                        key={key}
                        action={a}
                        state={cards[key] ?? { status: "idle" }}
                        onApply={() => applyAction(key, a)}
                        onDismiss={() => dismiss(key)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          ),
        )}
        {sending && <div style={{ ...asstBubbleStyle, color: colors.textMuted }}>Claude is thinking…</div>}
      </div>

      {error && <div style={errStyle}>{error}</div>}

      <div style={inputRowStyle}>
        <textarea
          style={textareaStyle}
          value={input}
          placeholder="Ask about this ticket…  (Enter to send, Shift+Enter for newline)"
          rows={2}
          onChange={(e) => setInput(e.currentTarget.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={sending}
        />
        <button className="primary" style={sendBtnStyle} onClick={() => void send()} disabled={sending || !input.trim()}>
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function ClaudeBadge({ status, connOk }: { status: ClaudeStatus | null; connOk?: boolean }) {
  let label = "Claude: checking…";
  let color = colors.textFaint;
  if (status) {
    if (!status.installed) {
      label = "Claude: not found";
      color = colors.danger;
    } else if (connOk === true) {
      label = "Claude: logged in";
      color = SUCCESS;
    } else {
      label = "Claude: installed";
      color = colors.textMuted;
    }
  }
  return <span style={{ fontSize: 12, fontWeight: 600, color }}>● {label}</span>;
}

function actionLabel(a: AssistantAction): string {
  switch (a.type) {
    case "comment":
      return "Add comment";
    case "set_status":
      return `Set status → ${a.status}`;
    case "create_subtask":
      return `Create subtask: ${a.name}`;
    case "set_priority":
      return `Set priority → ${a.priority}`;
    case "set_due_date":
      return `Set due date → ${a.date}`;
  }
}

function actionDetail(a: AssistantAction): string | null {
  if (a.type === "comment") return a.text;
  if (a.type === "create_subtask") return a.description ?? null;
  return null;
}

function ActionCard({
  action,
  state,
  onApply,
  onDismiss,
}: {
  action: AssistantAction;
  state: CardState;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const detail = actionDetail(action);
  const settled = state.status === "done" || state.status === "dismissed";
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: colors.text }}>{actionLabel(action)}</div>
      {detail && (
        <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 3, whiteSpace: "pre-wrap" }}>{detail}</div>
      )}
      {state.status === "error" && (
        <div style={{ fontSize: 12, color: colors.danger, marginTop: 4 }}>{state.message}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: space(2), marginTop: space(2) }}>
        {settled ? (
          <span style={{ fontSize: 12, fontWeight: 600, color: state.status === "done" ? SUCCESS : colors.textFaint }}>
            {state.status === "done" ? "Applied ✓" : "Dismissed"}
          </span>
        ) : (
          <>
            <button className="primary" style={cardBtnStyle} onClick={onApply} disabled={state.status === "applying"}>
              {state.status === "applying" ? "Applying…" : "Apply"}
            </button>
            <button style={ghostBtnStyle} onClick={onDismiss} disabled={state.status === "applying"}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const wrapStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

const badgeRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  padding: `${space(2)}px ${space(4)}px`,
  borderBottom: `1px solid ${colors.border}`,
};

const smallBtnStyle: CSSProperties = {
  border: `1px solid ${colors.border}`,
  background: colors.surface,
  borderRadius: radius.sm,
  padding: `${space(1)}px ${space(2)}px`,
  fontSize: 12,
  cursor: "pointer",
  color: colors.textMuted,
};

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: `${space(4)}px ${space(5)}px`,
  display: "flex",
  flexDirection: "column",
  gap: space(2),
};

const emptyStyle: CSSProperties = {
  fontSize: 13,
  color: colors.textFaint,
  lineHeight: 1.5,
  margin: "auto 0",
};

const userBubbleStyle: CSSProperties = {
  alignSelf: "flex-end",
  maxWidth: "85%",
  background: colors.accent,
  color: "#ffffff",
  borderRadius: radius.sm,
  padding: `${space(2)}px ${space(2.5)}px`,
  fontSize: 13,
  whiteSpace: "pre-wrap",
};

const asstBubbleStyle: CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "92%",
  background: colors.surfaceAlt,
  borderRadius: radius.sm,
  padding: `${space(1)}px ${space(2.5)}px`,
  fontSize: 13,
};

const cardStyle: CSSProperties = {
  alignSelf: "flex-start",
  width: "92%",
  border: `1px solid ${colors.border}`,
  background: colors.surface,
  borderRadius: radius.sm,
  padding: `${space(2)}px ${space(2.5)}px`,
};

const cardBtnStyle: CSSProperties = {
  padding: `${space(1)}px ${space(3)}px`,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

const ghostBtnStyle: CSSProperties = {
  padding: `${space(1)}px ${space(3)}px`,
  fontSize: 12.5,
  border: `1px solid ${colors.border}`,
  background: colors.surface,
  borderRadius: radius.sm,
  cursor: "pointer",
  color: colors.textMuted,
};

const inputRowStyle: CSSProperties = {
  display: "flex",
  gap: space(2),
  alignItems: "flex-end",
  padding: `${space(2.5)}px ${space(4)}px`,
  borderTop: `1px solid ${colors.border}`,
};

const textareaStyle: CSSProperties = {
  flex: 1,
  resize: "none",
  fontFamily: "inherit",
  fontSize: 13,
  padding: `${space(2)}px ${space(2.5)}px`,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  outline: "none",
};

const sendBtnStyle: CSSProperties = {
  padding: `${space(2)}px ${space(3)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const errStyle: CSSProperties = {
  margin: `0 ${space(4)}px ${space(2)}px`,
  padding: `${space(2)}px ${space(3)}px`,
  fontSize: 12.5,
  color: colors.danger,
  background: "#fdecec",
  borderRadius: radius.sm,
};
