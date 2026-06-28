import { useCallback, useEffect, useRef, useState } from "react";
import type { ClickUpTask } from "../lib/clickup";
import { cancelAgent } from "../lib/agent";
import { runQueue, type QueueConfig, type QueueControl, type QueueItem } from "../lib/queue";

const STORE_KEY = "cu-queue";

type Persisted = {
  task: ClickUpTask;
  state: QueueItem["state"];
  summary?: string;
  error?: string;
};

function load(): QueueItem[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Persisted[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && p.task && typeof p.task.id === "string")
      .map((p) => ({
        task: p.task,
        // A half-finished run from a previous session is stale → reset it to pending.
        state: p.state === "running" || p.state === "verifying" ? "pending" : p.state,
        summary: p.summary,
        error: p.error,
      }));
  } catch {
    return [];
  }
}

/**
 * Owns the ticket queue: the item list (persisted to localStorage, minus the heavy live
 * transcript), the running flag, and the halt info. `start(config)` drives `runQueue`; `stop`
 * cancels the active agent run and halts. add/remove/clear are blocked while running.
 */
export function useQueue() {
  const [items, setItems] = useState<QueueItem[]>(() => load());
  const [running, setRunning] = useState(false);
  const [halt, setHalt] = useState<{ index: number; taskName: string; error: string } | null>(null);
  const control = useRef<QueueControl>({ stopped: false, currentRunId: null });
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Persist a slim copy (drop the live transcript — it can be large and is session-only).
  useEffect(() => {
    try {
      const slim: Persisted[] = items.map((it) => ({
        task: it.task,
        state: it.state,
        summary: it.summary,
        error: it.error,
      }));
      localStorage.setItem(STORE_KEY, JSON.stringify(slim));
    } catch {
      /* ignore storage failures */
    }
  }, [items]);

  // Stop any in-flight run if the hook is torn down (e.g. the app closing).
  useEffect(() => {
    return () => {
      control.current.stopped = true;
      const id = control.current.currentRunId;
      if (id) void cancelAgent(id).catch(() => {});
    };
  }, []);

  const add = useCallback(
    (tasks: ClickUpTask[]) => {
      if (running) return; // queue is immutable while running (matches the disabled UI)
      setItems((cur) => {
        const have = new Set(cur.map((i) => i.task.id));
        const extra = tasks.filter((t) => !have.has(t.id)).map((t): QueueItem => ({ task: t, state: "pending" }));
        return extra.length ? [...cur, ...extra] : cur;
      });
    },
    [running],
  );

  const remove = useCallback(
    (id: string) => {
      if (running) return;
      setItems((cur) => cur.filter((i) => i.task.id !== id));
    },
    [running],
  );

  const clear = useCallback(() => {
    if (running) return;
    setItems([]);
    setHalt(null);
  }, [running]);

  const clearSucceeded = useCallback(() => {
    if (running) return;
    setItems((cur) => cur.filter((i) => i.state !== "succeeded"));
  }, [running]);

  const resetFailed = useCallback(() => {
    if (running) return;
    setItems((cur) =>
      cur.map((i) => (i.state === "failed" ? { ...i, state: "pending", error: undefined } : i)),
    );
    setHalt(null);
  }, [running]);

  const start = useCallback(
    async (config: QueueConfig) => {
      if (running) return;
      const snapshot = itemsRef.current; // runQueue indexes against this ordering
      if (!snapshot.some((i) => i.state === "pending")) return;
      setHalt(null);
      setRunning(true);
      control.current = { stopped: false, currentRunId: null };
      try {
        await runQueue(
          snapshot,
          config,
          {
            onItem: (index, patch) =>
              setItems((cur) => cur.map((it, i) => (i === index ? { ...it, ...patch } : it))),
            onHalt: (index, error) =>
              setHalt({ index, taskName: itemsRef.current[index]?.task.name ?? "ticket", error }),
            onDone: () => {},
          },
          control.current,
        );
      } finally {
        setRunning(false);
      }
    },
    [running],
  );

  const stop = useCallback(() => {
    control.current.stopped = true;
    const id = control.current.currentRunId;
    if (id) void cancelAgent(id).catch(() => {});
  }, []);

  return { items, running, halt, add, remove, clear, clearSucceeded, resetFailed, start, stop };
}
