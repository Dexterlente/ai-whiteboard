import { useCallback, useEffect, useRef, useState } from "react";
import { toMessage } from "../lib/errors";
import {
  applyEvent,
  cancelAgent,
  deleteAgentSession,
  loadAgentSession,
  runAgent,
  saveAgentSession,
  type AgentState,
  type AssistantTurn,
  type PermissionMode,
} from "../lib/agent";

const EMPTY: AgentState = { transcript: [], sessionId: null };

/** Mark the trailing assistant turn as no longer streaming. */
function settleLast(s: AgentState): AgentState {
  const li = s.transcript.length - 1;
  if (li < 0 || s.transcript[li].role !== "assistant") return s;
  const a = s.transcript[li] as AssistantTurn;
  const transcript = s.transcript.slice();
  transcript[li] = {
    ...a,
    // Preserve any uncommitted streamed preview (e.g. when stopped mid-stream).
    text: a.streamingText ? (a.text ? `${a.text}\n\n${a.streamingText}` : a.streamingText) : a.text,
    streaming: false,
    streamingText: "",
  };
  return { ...s, transcript };
}

/**
 * Drives one persistent agent session: loads its saved transcript, streams `claude` runs,
 * resumes the CLI session across turns, and supports stop + clear. Keyed by `sessionKey`
 * (a folder hash for the standalone Claude Code panel).
 */
export function useAgentSession(opts: {
  sessionKey: string;
  cwd: string;
  permissionMode: PermissionMode;
  appendSystemPrompt?: string;
  model?: string;
  effort?: string;
}) {
  const { sessionKey, cwd, permissionMode, appendSystemPrompt, model, effort } = opts;
  const [state, setState] = useState<AgentState>(EMPTY);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadedRef = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const runningRef = useRef(false); // synchronous re-entrancy guard (state lags a render)
  const stderrRef = useRef<string[]>([]); // recent stderr lines, surfaced if a run exits non-zero
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = state.sessionId;

  // Latest live options, read at send time (so `send` can stay referentially stable).
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const permRef = useRef(permissionMode);
  permRef.current = permissionMode;
  const appendRef = useRef(appendSystemPrompt);
  appendRef.current = appendSystemPrompt;
  const modelRef = useRef(model);
  modelRef.current = model;
  const effortRef = useRef(effort);
  effortRef.current = effort;

  // Serialize all disk writes for this session so a save can never land after a delete.
  const ioChain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueIo = useCallback((op: () => Promise<unknown>) => {
    ioChain.current = ioChain.current.then(op, op);
  }, []);

  // Load the persisted session whenever the key changes.
  useEffect(() => {
    loadedRef.current = false;
    setState(EMPTY);
    setError(null);
    let cancelled = false;
    loadAgentSession(sessionKey)
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.transcript)) {
            setState({ transcript: parsed.transcript, sessionId: parsed.sessionId ?? null });
          }
        } catch {
          /* corrupt file → start fresh */
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) loadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  // Cancel any in-flight run when the key changes or the component unmounts, so a backgrounded
  // `claude` process is never orphaned (and its events stop mutating a dead hook).
  useEffect(() => {
    return () => {
      const id = runIdRef.current;
      runIdRef.current = null;
      runningRef.current = false;
      if (id) void cancelAgent(id).catch(() => {});
    };
  }, [sessionKey]);

  // Persist after each settled change (never mid-stream). Don't recreate a cleared session.
  useEffect(() => {
    if (!loadedRef.current || running) return;
    if (state.transcript.length === 0) return;
    const snapshot = JSON.stringify({ sessionId: state.sessionId, transcript: state.transcript });
    enqueueIo(() => saveAgentSession(sessionKey, snapshot).catch(() => {}));
  }, [state, running, sessionKey, enqueueIo]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || runningRef.current) return;
      setError(null);
      const runId = "run" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      runIdRef.current = runId;
      runningRef.current = true;
      stderrRef.current = [];
      const firstTurn = sessionIdRef.current == null; // send the system context only once
      setState((s) => ({
        ...s,
        transcript: [
          ...s.transcript,
          { role: "user", text: t },
          { role: "assistant", text: "", tools: [], streaming: true },
        ],
      }));
      setRunning(true);
      try {
        await runAgent({
          runId,
          prompt: t,
          cwd: cwdRef.current,
          permissionMode: permRef.current,
          resume: sessionIdRef.current,
          appendSystemPrompt: firstTurn ? appendRef.current : undefined,
          model: modelRef.current,
          effort: effortRef.current,
          onEvent: (e) => {
            if (runIdRef.current !== runId) return; // ignore events from a superseded/stopped run
            if (e.kind === "stdout") {
              setState((s) => applyEvent(s, e.line));
            } else if (e.kind === "stderr") {
              stderrRef.current.push(e.line);
              if (stderrRef.current.length > 50) stderrRef.current.shift();
            } else if (e.kind === "done") {
              setState((s) => settleLast(e.sessionId ? { ...s, sessionId: e.sessionId } : s));
              if (e.exitCode != null && e.exitCode !== 0) {
                const tail = stderrRef.current.slice(-8).join("\n").trim();
                setError(
                  tail ||
                    `The agent exited with code ${e.exitCode}. If this persists, run \`claude login\`.`,
                );
              }
              runningRef.current = false;
              runIdRef.current = null;
              setRunning(false);
            }
          },
        });
      } catch (e) {
        if (runIdRef.current !== runId) return; // a newer run/stop already took over
        setError(toMessage(e));
        setState(settleLast);
        runningRef.current = false;
        runIdRef.current = null;
        setRunning(false);
      }
    },
    [], // reads everything through refs → stable
  );

  const stop = useCallback(() => {
    const id = runIdRef.current;
    if (!id) return;
    // Drop late events from this run. (If stopped before the session id has streamed, the
    // next turn starts a fresh CLI session — acceptable for an interrupted turn.)
    runIdRef.current = null;
    runningRef.current = false;
    void cancelAgent(id).catch(() => {});
    setState(settleLast);
    setRunning(false);
  }, []);

  const clear = useCallback(() => {
    if (runningRef.current) return; // stop first
    enqueueIo(() => deleteAgentSession(sessionKey).catch(() => {}));
    setState(EMPTY);
    setError(null);
  }, [sessionKey, enqueueIo]);

  return { state, running, error, send, stop, clear };
}
