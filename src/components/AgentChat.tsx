import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { renderMarkdown } from "../lib/markdown";
import { useAgentSession } from "../hooks/useAgentSession";
import {
  BUILTIN_SLASH_COMMANDS,
  listSlashCommands,
  toolLabel,
  type AssistantTurn,
  type PermissionMode,
  type SlashCommand,
  type ToolCall,
} from "../lib/agent";
import { colors, radius, space } from "./ui";

/**
 * Reusable agentic Claude Code chat: streams a `claude` session running in `cwd`, renders
 * text + tool activity live, and persists/clears the conversation under `sessionKey`.
 */
export function AgentChat({
  sessionKey,
  cwd,
  permissionMode,
  appendSystemPrompt,
  placeholder,
  disabledReason,
  model,
  effort,
}: {
  sessionKey: string;
  cwd: string;
  permissionMode: PermissionMode;
  appendSystemPrompt?: string;
  placeholder?: string;
  disabledReason?: string; // when set, sending is blocked and this is shown
  model?: string;
  effort?: string;
}) {
  const { state, running, error, send, stop, clear } = useAgentSession({
    sessionKey,
    cwd,
    permissionMode,
    appendSystemPrompt,
    model,
    effort,
  });
  const [input, setInput] = useState("");
  const composing = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [state, running]);

  // Slash-command autocomplete: built-ins + custom commands from the work folder / home.
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);

  useEffect(() => {
    if (!cwd.trim()) {
      setCustomCommands([]);
      return;
    }
    listSlashCommands(cwd)
      .then(setCustomCommands)
      .catch(() => setCustomCommands([]));
  }, [cwd]);

  const allCommands = useMemo(() => {
    const seen = new Set<string>();
    const merged: SlashCommand[] = [];
    for (const c of [...customCommands, ...BUILTIN_SLASH_COMMANDS]) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        merged.push(c);
      }
    }
    return merged;
  }, [customCommands]);

  // Show the menu only while typing a single "/token" (no space yet).
  const slashQuery = /^\/(\S*)$/.test(input) ? input.slice(1).toLowerCase() : null;
  const matches =
    slashQuery !== null
      ? allCommands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 8)
      : [];
  const menuOpen = matches.length > 0 && !menuDismissed;
  const idx = Math.min(menuIndex, matches.length - 1);

  function applyCommand(name: string) {
    setInput(`/${name} `);
    setMenuIndex(0);
  }

  const blocked = !!disabledReason;
  function submit() {
    if (blocked || running) return;
    const t = input.trim();
    if (!t) return;
    setInput("");
    void send(t);
  }

  return (
    <div style={wrapStyle}>
      <div style={headerStyle}>
        <span style={{ fontSize: 12, color: colors.textMuted, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: running ? "#f59e0b" : state.sessionId ? "#16a34a" : colors.textFaint }}>●</span>
          {running ? "running…" : state.sessionId ? "session active" : "new session"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          style={smallBtnStyle}
          disabled={running || state.transcript.length === 0}
          onClick={() => {
            if (window.confirm("Clear this session? The saved conversation will be deleted.")) clear();
          }}
        >
          Clear
        </button>
      </div>

      <div ref={scrollRef} style={scrollStyle}>
        {state.transcript.length === 0 && (
          <div style={emptyStyle}>
            Full Claude Code session in your work folder — ask anything, run slash commands like{" "}
            <code>/code-review</code>, or have it edit files and run commands. It uses your Claude
            login and the folder above.
          </div>
        )}
        {state.transcript.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} style={userBubbleStyle}>
              {turn.text}
            </div>
          ) : (
            <AssistantBubble key={i} turn={turn} />
          ),
        )}
      </div>

      {error && <div style={errStyle}>{error}</div>}
      {blocked && <div style={noticeStyle}>{disabledReason}</div>}

      <div style={{ position: "relative" }}>
        {menuOpen && (
          <div style={slashMenuStyle}>
            {matches.map((c, i) => (
              <button
                key={`${c.source}:${c.name}`}
                style={{ ...slashItemStyle, background: i === idx ? "rgba(99, 102, 241, 0.12)" : "transparent" }}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  applyCommand(c.name);
                }}
                onMouseEnter={() => setMenuIndex(i)}
              >
                <span style={{ fontWeight: 600, color: colors.text }}>/{c.name}</span>
                <span style={slashDescStyle}>{c.description}</span>
                <span style={slashSrcStyle}>{c.source}</span>
              </button>
            ))}
          </div>
        )}
        <div style={inputRowStyle}>
          <textarea
            style={{ ...textareaStyle, ...(blocked ? { background: colors.surfaceAlt, cursor: "not-allowed" } : {}) }}
            value={input}
            placeholder={placeholder ?? "Ask Claude…   ( / for commands )"}
            rows={2}
            disabled={blocked}
            onChange={(e) => {
              setInput(e.currentTarget.value);
              setMenuIndex(0);
              setMenuDismissed(false);
            }}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onKeyDown={(e) => {
              if (menuOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMenuIndex((i) => (Math.min(i, matches.length - 1) + 1) % matches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMenuIndex((i) => (Math.min(i, matches.length - 1) - 1 + matches.length) % matches.length);
                  return;
                }
                if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  applyCommand(matches[idx].name);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  applyCommand(matches[idx].name);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMenuDismissed(true);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {running ? (
            <button style={stopBtnStyle} onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              className="primary"
              style={sendBtnStyle}
              onClick={submit}
              disabled={blocked || !input.trim()}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// memo + useMemo: during streaming the whole transcript re-renders every token; only the
// live turn's object changes, and markdown is re-parsed only when committed text changes.
const AssistantBubble = memo(function AssistantBubble({ turn }: { turn: AssistantTurn }) {
  const hasText = turn.text.trim().length > 0;
  const html = useMemo(() => (hasText ? renderMarkdown(turn.text) : ""), [turn.text, hasText]);
  return (
    <div style={{ alignSelf: "flex-start", maxWidth: "94%" }}>
      {hasText && (
        <div className="cu-markdown" style={asstBubbleStyle} dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {turn.streamingText && (
        <div style={{ ...asstBubbleStyle, whiteSpace: "pre-wrap" }}>
          {turn.streamingText}
          <span style={caretStyle}>▋</span>
        </div>
      )}
      {turn.tools.map((t, i) => (
        <ToolRow key={t.id || i} tool={t} />
      ))}
      {turn.error && <div style={turnErrorStyle}>{turn.error}</div>}
      {!hasText && !turn.streamingText && turn.tools.length === 0 && !turn.error && turn.streaming && (
        <div style={{ ...asstBubbleStyle, color: colors.textMuted }}>Claude is thinking…</div>
      )}
    </div>
  );
});

const ToolRow = memo(function ToolRow({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={toolRowStyle}>
      <button style={toolHeadStyle} onClick={() => setOpen((v) => !v)}>
        <span style={{ color: tool.isError ? colors.danger : colors.textMuted }}>
          {toolLabel(tool.name, tool.inputPreview)}
        </span>
        {tool.result && <span style={{ color: colors.textFaint, fontSize: 11 }}>{open ? "▾" : "▸"}</span>}
      </button>
      {open && tool.result && <pre style={toolResultStyle}>{tool.result}</pre>}
    </div>
  );
});

const turnErrorStyle: CSSProperties = {
  alignSelf: "flex-start",
  fontSize: 12.5,
  color: colors.danger,
  background: "#fdecec",
  borderRadius: radius.sm,
  padding: `${space(1.5)}px ${space(2.5)}px`,
  marginBottom: space(1),
};

const wrapStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};
const headerStyle: CSSProperties = {
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
  background: colors.surfaceAlt,
  borderRadius: radius.sm,
  padding: `${space(1)}px ${space(2.5)}px`,
  fontSize: 13,
  marginBottom: space(1),
};
const caretStyle: CSSProperties = { opacity: 0.5 };
const toolRowStyle: CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  background: colors.surface,
  marginBottom: space(1),
};
const toolHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: space(2),
  width: "100%",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  padding: `${space(1.5)}px ${space(2.5)}px`,
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  textAlign: "left",
};
const toolResultStyle: CSSProperties = {
  margin: 0,
  padding: `${space(1.5)}px ${space(2.5)}px`,
  borderTop: `1px solid ${colors.border}`,
  fontSize: 11.5,
  color: colors.textMuted,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 200,
  overflow: "auto",
};
const inputRowStyle: CSSProperties = {
  display: "flex",
  gap: space(2),
  alignItems: "flex-end",
  padding: `${space(2.5)}px ${space(4)}px`,
  borderTop: `1px solid ${colors.border}`,
};
const slashMenuStyle: CSSProperties = {
  position: "absolute",
  bottom: "100%",
  left: space(4),
  right: space(4),
  marginBottom: space(1),
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  boxShadow: colors.shadow,
  maxHeight: 240,
  overflowY: "auto",
  padding: space(1),
  zIndex: 30,
};
const slashItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: space(2),
  width: "100%",
  textAlign: "left",
  border: "none",
  borderRadius: radius.sm,
  padding: `${space(1.5)}px ${space(2.5)}px`,
  cursor: "pointer",
  fontSize: 13,
};
const slashDescStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: colors.textFaint,
  fontSize: 11.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const slashSrcStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: 10,
  color: colors.textFaint,
  textTransform: "uppercase",
  letterSpacing: 0.4,
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
  borderRadius: radius.sm, // match the Stop button geometry
};
const stopBtnStyle: CSSProperties = {
  padding: `${space(2)}px ${space(3)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  border: `1px solid ${colors.danger}`,
  background: colors.surface,
  color: colors.danger,
  borderRadius: radius.sm,
};
const errStyle: CSSProperties = {
  margin: `0 ${space(4)}px ${space(2)}px`,
  padding: `${space(2)}px ${space(3)}px`,
  fontSize: 12.5,
  color: colors.danger,
  background: "#fdecec",
  borderRadius: radius.sm,
};
const noticeStyle: CSSProperties = {
  margin: `0 ${space(4)}px ${space(2)}px`,
  padding: `${space(2)}px ${space(3)}px`,
  fontSize: 12.5,
  color: colors.textMuted,
  background: colors.surfaceAlt,
  borderRadius: radius.sm,
};
