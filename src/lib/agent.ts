import { invoke, Channel } from "@tauri-apps/api/core";

// --- Events from the Rust streaming command (keys match the Rust AgentEvent, camelCase) ---
export type AgentEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "done"; exitCode: number | null; sessionId: string | null };

/** Permission level the user picks; mapped to `claude --permission-mode` flags in Rust. */
export type PermissionMode = "read" | "acceptEdits" | "auto" | "full";

// --- Renderable transcript model (built by the reducer below) ---
export type ToolCall = {
  id: string;
  name: string;
  inputPreview: string;
  result?: string;
  isError?: boolean;
};
export type UserTurn = { role: "user"; text: string };
export type AssistantTurn = {
  role: "assistant";
  text: string; // committed assistant text (markdown)
  streamingText?: string; // live preview of the current block while streaming
  tools: ToolCall[];
  streaming?: boolean;
  error?: string; // set when the run ended in an error (is_error result)
};
export type AgentTurn = UserTurn | AssistantTurn;
export type Transcript = AgentTurn[];
export type AgentState = { transcript: Transcript; sessionId: string | null };

// --- Tauri command wrappers ---

/** Spawn an agentic `claude` run; events stream back through the Channel. Resolves once
 * the process has launched (completion is signalled by the `done` event, not this promise). */
export function runAgent(opts: {
  runId: string;
  prompt: string;
  cwd: string;
  permissionMode: PermissionMode;
  resume?: string | null;
  appendSystemPrompt?: string;
  addDirs?: string[];
  model?: string | null; // "" / null → CLI default
  effort?: string | null; // claude --effort: low | medium | high | xhigh | max
  onEvent: (e: AgentEvent) => void;
}): Promise<void> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = opts.onEvent;
  return invoke("claude_run", {
    onEvent: channel,
    runId: opts.runId,
    prompt: opts.prompt,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    resume: opts.resume ?? null,
    appendSystemPrompt: opts.appendSystemPrompt ?? null,
    addDirs: opts.addDirs ?? null,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
  });
}

export const cancelAgent = (runId: string) => invoke("claude_cancel", { runId });

/** Result of the Rust `run_verify` command (the queue's build/test gate). */
export type VerifyResult = { exitCode: number | null; output: string };

/** Run a build/test command in `cwd` and report pass/fail + output (queue verification). */
export const runVerify = (cwd: string, command: string) =>
  invoke<VerifyResult>("run_verify", { cwd, command });

// --- Slash commands (for the chat input autocomplete) ---
export type SlashCommand = { name: string; description: string; source: string };

/** Custom commands discovered from the work folder's + home's .claude/commands. */
export const listSlashCommands = (cwd: string) =>
  invoke<SlashCommand[]>("list_slash_commands", { cwd });

/** Built-in Claude Code slash commands (mirrors the CLI's list). */
export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Choose the model for this session", source: "built-in" },
  { name: "effort", description: "Set reasoning effort (low … max)", source: "built-in" },
  { name: "code-review", description: "Review the current diff for bugs and cleanups", source: "built-in" },
  { name: "review", description: "Review a pull request", source: "built-in" },
  { name: "security-review", description: "Security review of pending changes", source: "built-in" },
  { name: "init", description: "Generate a CLAUDE.md for this project", source: "built-in" },
  { name: "compact", description: "Summarize and compact the conversation", source: "built-in" },
  { name: "context", description: "Show what's loaded in the context window", source: "built-in" },
  { name: "cost", description: "Show token usage and cost", source: "built-in" },
  { name: "usage", description: "Show plan usage limits", source: "built-in" },
  { name: "agents", description: "Manage subagents", source: "built-in" },
  { name: "mcp", description: "Manage MCP servers", source: "built-in" },
  { name: "memory", description: "Edit CLAUDE.md memory files", source: "built-in" },
  { name: "hooks", description: "Manage hooks", source: "built-in" },
  { name: "permissions", description: "Manage tool permissions", source: "built-in" },
  { name: "add-dir", description: "Add another working directory", source: "built-in" },
  { name: "config", description: "Open settings", source: "built-in" },
  { name: "status", description: "Show session status", source: "built-in" },
  { name: "doctor", description: "Diagnose the installation", source: "built-in" },
  { name: "clear", description: "Clear conversation history", source: "built-in" },
  { name: "help", description: "List available commands", source: "built-in" },
];

// Shared work-folder + permission settings (single source of truth for the panel + ticket agent).
export const AGENT_FOLDER_KEY = "cu-agent-folder";
export const AGENT_PERM_KEY = "cu-agent-perm";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";
export const AGENT_MODEL_KEY = "cu-agent-model";
export const AGENT_EFFORT_KEY = "cu-agent-effort";

/** Selectable agent options, shared by the Claude Code panel and the queue config. */
export const PERM_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "read", label: "Read-only" },
  { value: "acceptEdits", label: "Auto-edits (default)" },
  { value: "auto", label: "Auto" },
  { value: "full", label: "Full — runs any command" },
];
export const MODEL_OPTIONS = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];
export const EFFORT_OPTIONS = [
  { value: "", label: "Default effort" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Xhigh" },
  { value: "max", label: "Max" },
];

export function getAgentFolder(): string {
  try {
    return localStorage.getItem(AGENT_FOLDER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function getAgentPermission(): PermissionMode {
  try {
    const v = localStorage.getItem(AGENT_PERM_KEY);
    return v === "read" || v === "acceptEdits" || v === "auto" || v === "full"
      ? v
      : DEFAULT_PERMISSION_MODE;
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
}
export const saveAgentSession = (key: string, json: string) =>
  invoke("save_agent_session", { key, json });
export const loadAgentSession = (key: string) => invoke<string>("load_agent_session", { key });
export const deleteAgentSession = (key: string) => invoke("delete_agent_session", { key });

/** Stable, path-traversal-safe session key for a work folder (the Rust key validator
 * forbids `/` and `.`, so the absolute path is hashed). */
export function sessionKeyForFolder(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "panel-" + (h >>> 0).toString(16).padStart(8, "0");
}

// --- Pure stream-json reducer (the unit-tested seam) ---

function truncate(s: string, n = 100): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** A short, human label for a tool call's input. */
export function toolInputPreview(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Bash":
      return truncate(String(input.command ?? ""));
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return String(input.file_path ?? input.path ?? "");
    case "Grep":
    case "Glob":
      return String(input.pattern ?? "");
    case "Task":
      return truncate(String(input.description ?? input.subagent_type ?? ""));
    default: {
      const firstStr = Object.values(input).find((v) => typeof v === "string");
      return truncate(String(firstStr ?? ""));
    }
  }
}

/** Display label for a tool row, e.g. "💻 Bash: npm test" or "🔧 Read src/x.ts". */
export function toolLabel(name: string, inputPreview: string): string {
  const icon = name === "Bash" ? "💻" : "🔧";
  return inputPreview ? `${icon} ${name}: ${inputPreview}` : `${icon} ${name}`;
}

function toolResultText(content: any): string {
  if (typeof content === "string") return truncate(content, 400);
  if (Array.isArray(content)) {
    return truncate(
      content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n").trim(),
      400,
    );
  }
  return "";
}

/**
 * Fold one stream-json stdout line into the transcript. Defensive: non-JSON lines and
 * unknown event types are ignored. Mutates only the trailing assistant turn (the one the
 * hook appends before a run). Accumulates streamed text deltas as a live preview, then
 * commits the authoritative text from finalized `assistant` messages, and attaches
 * `tool_result`s to their `tool_use` by id.
 */
export function applyEvent(state: AgentState, line: string): AgentState {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return state;
  }
  if (!msg || typeof msg !== "object") return state;

  const sessionId = typeof msg.session_id === "string" ? msg.session_id : state.sessionId;

  const turns = state.transcript;
  const lastIdx = turns.length - 1;
  const last = lastIdx >= 0 ? turns[lastIdx] : undefined;
  if (!last || last.role !== "assistant") {
    // Nothing to attach to (only session-id capture matters here).
    return sessionId === state.sessionId ? state : { ...state, sessionId };
  }

  const withLast = (updater: (a: AssistantTurn) => AssistantTurn): AgentState => {
    const copy = turns.slice();
    copy[lastIdx] = updater(last);
    return { transcript: copy, sessionId };
  };

  switch (msg.type) {
    case "stream_event": {
      const ev = msg.event;
      if (
        ev?.type === "content_block_delta" &&
        ev.delta?.type === "text_delta" &&
        typeof ev.delta.text === "string"
      ) {
        return withLast((a) => ({ ...a, streamingText: (a.streamingText ?? "") + ev.delta.text }));
      }
      return sessionId === state.sessionId ? state : { ...state, sessionId };
    }
    case "assistant": {
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      return withLast((a) => {
        let text = a.text;
        const tools = a.tools.slice();
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            text = text ? text + "\n\n" + block.text : block.text;
          } else if (block?.type === "tool_use") {
            tools.push({
              id: String(block.id ?? ""),
              name: String(block.name ?? "tool"),
              inputPreview: toolInputPreview(String(block.name ?? ""), block.input),
            });
          }
        }
        return { ...a, text, tools, streamingText: "" };
      });
    }
    case "user": {
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      return withLast((a) => {
        const tools = a.tools.slice();
        for (const block of content) {
          if (block?.type === "tool_result") {
            const id = String(block.tool_use_id ?? "");
            const i = tools.findIndex((x) => x.id === id);
            if (i >= 0) {
              tools[i] = {
                ...tools[i],
                result: toolResultText(block.content),
                isError: !!block.is_error,
              };
            }
          }
        }
        return { ...a, tools };
      });
    }
    case "result":
      return withLast((a) => ({
        ...a,
        // Commit any uncommitted streamed preview, and flag an errored termination.
        text: a.streamingText ? (a.text ? `${a.text}\n\n${a.streamingText}` : a.streamingText) : a.text,
        streaming: false,
        streamingText: "",
        error: msg.is_error
          ? `Run ended with an error${typeof msg.subtype === "string" ? ` (${msg.subtype})` : ""}.`
          : a.error,
      }));
    default:
      return sessionId === state.sessionId ? state : { ...state, sessionId };
  }
}

/**
 * Run one agent turn to completion (used by the ticket queue, not the chat panel): spawn
 * `runAgent`, fold streamed stdout into a transcript via `applyEvent`, and resolve on the
 * terminal `done` event. `onState` streams live progress to the UI. Rejects only if the
 * process fails to launch — a non-zero run is reported via the resolved `exitCode`.
 */
export async function runAgentToCompletion(
  opts: Omit<Parameters<typeof runAgent>[0], "onEvent"> & {
    onState?: (state: AgentState) => void;
  },
): Promise<{ exitCode: number | null; sessionId: string | null; transcript: Transcript }> {
  const { onState, ...runOpts } = opts;
  let state: AgentState = {
    transcript: [{ role: "assistant", text: "", tools: [], streaming: true }],
    sessionId: null,
  };
  onState?.(state);
  return new Promise((resolve, reject) => {
    let settled = false;
    runAgent({
      ...runOpts,
      onEvent: (e) => {
        if (e.kind === "stdout") {
          state = applyEvent(state, e.line);
          onState?.(state);
        } else if (e.kind === "done" && !settled) {
          settled = true;
          resolve({
            exitCode: e.exitCode,
            sessionId: e.sessionId ?? state.sessionId,
            transcript: state.transcript,
          });
        }
      },
    }).catch((err) => {
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
