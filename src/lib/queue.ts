import {
  addComment,
  fetchComments,
  fetchListStatuses,
  fetchTaskDetail,
  setStatus,
  type ClickUpTask,
  type Comment,
} from "./clickup";
import {
  runAgentToCompletion,
  runVerify,
  type AgentState,
  type PermissionMode,
  type Transcript,
} from "./agent";
import { toMessage } from "./errors";

export type QueueItemState = "pending" | "running" | "verifying" | "succeeded" | "failed";

export type QueueItem = {
  task: ClickUpTask;
  state: QueueItemState;
  summary?: string; // agent's final message (on success or failed-verify)
  error?: string; // failure reason (agent error / verify output)
  transcript?: Transcript; // live agent transcript for the active/finished item
};

export type QueueConfig = {
  cwd: string;
  permissionMode: PermissionMode;
  model: string;
  effort: string;
  verifyCommand: string;
  inProgressStatus: string;
  doneStatus: string;
  basePrompt: string;
};

/** Mutable handle the UI passes in so it can stop a run mid-flight (sets stopped + cancels the run). */
export type QueueControl = { stopped: boolean; currentRunId: string | null };

export type QueueCallbacks = {
  /** Merge a partial update into item `index` (state, transcript, summary, error). */
  onItem: (index: number, patch: Partial<QueueItem>) => void;
  /** The queue halted at item `index` because of a failure. */
  onHalt: (index: number, error: string) => void;
  /** The queue finished (reached the end or was stopped). */
  onDone: () => void;
};

export const DEFAULT_BASE_PROMPT =
  "Work in this repository to resolve the ClickUp ticket described in the system context. " +
  "Make focused, correct edits to implement it. Do not commit or push. When you are done, " +
  "reply with a concise 2–5 sentence summary of exactly what you changed and why.";

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Per-ticket context block fed to the agent via `--append-system-prompt`. */
export function buildQueueTicketContext(
  task: ClickUpTask,
  detail: ClickUpTask | null,
  comments: Comment[],
  today: string,
): string {
  const d = detail ?? task;
  const description = d.markdownDescription || d.textDescription || "(none)";
  const assignees = d.assignees.length ? d.assignees.map((a) => a.username).join(", ") : "none";
  const commentLines = comments.length
    ? comments.map((c) => `  - ${c.author || "Unknown"}: ${c.text}`).join("\n")
    : "  (none)";
  return [
    "You are working through a queue of ClickUp tickets in the user's project folder.",
    `Today's date is ${today}.`,
    "",
    "CURRENT TICKET:",
    `- Title: ${d.name}`,
    `- Status: ${d.status || "(none)"}`,
    `- Priority: ${d.priority || "none"}`,
    `- List: ${d.listName || "(none)"}`,
    `- URL: ${d.url || "(none)"}`,
    `- Assignees: ${assignees}`,
    "- Description:",
    description,
    `- Comments (${comments.length}):`,
    commentLines,
    "",
    "Implement this ticket with full tool access in the working folder.",
  ].join("\n");
}

/** Resolve a desired status name against a list's real statuses (case-insensitive); null if absent. */
async function resolveStatus(listId: string | null, name: string): Promise<string | null> {
  const wanted = name.trim();
  if (!listId || !wanted) return null;
  try {
    const statuses = await fetchListStatuses(listId);
    return statuses.find((s) => s.toLowerCase() === wanted.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/** Sanitize a task id into a valid agent run id (Rust accepts alphanumeric/-/_ only). */
function runIdFor(taskId: string, n: number): string {
  return `queue-${taskId.replace(/[^a-zA-Z0-9_-]/g, "")}-${n}`;
}

function lastAssistantText(transcript: Transcript): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i];
    if (t.role === "assistant" && t.text.trim()) return t.text.trim();
  }
  return "";
}

function clip(s: string, n = 1500): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Best-effort comment — never let a failed write halt the queue on its own. */
async function postComment(taskId: string, text: string): Promise<void> {
  try {
    await addComment(taskId, text);
  } catch {
    /* ignore */
  }
}

/**
 * Drive the queue sequentially in a shared work folder. For each `pending` item: set the
 * in-progress status, run the agent to completion, run the verify command, and on success set
 * the done status + post a summary comment. HALTS the whole queue on the first agent error or
 * failed verify (leaving the remaining items `pending`). `control.stopped` + `cancelAgent` (via
 * the hook) stop a run mid-flight.
 */
export async function runQueue(
  items: QueueItem[],
  config: QueueConfig,
  callbacks: QueueCallbacks,
  control: QueueControl,
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    if (control.stopped) break;
    if (items[i].state !== "pending") continue; // resume: skip already-processed items

    const task = items[i].task;
    const taskId = task.id;
    callbacks.onItem(i, { state: "running", error: undefined, summary: undefined });

    // 1. Fetch fresh detail + comments. This also yields the ticket's CURRENT list (it may have
    //    moved lists since it was queued), which we use to resolve status names — using the stale
    //    queued listId could resolve a status against the wrong list and silently skip the write.
    let detail: ClickUpTask | null = null;
    let comments: Comment[] = [];
    try {
      [detail, comments] = await Promise.all([fetchTaskDetail(taskId), fetchComments(taskId)]);
    } catch {
      /* keep detail=null / comments=[] → fall back to the queued card data */
    }
    const listId = detail?.listId ?? task.listId;
    const context = buildQueueTicketContext(task, detail, comments, todayISO());

    // 2. Mark in-progress in ClickUp (best-effort; a write failure must not abort the work).
    const inProg = await resolveStatus(listId, config.inProgressStatus);
    if (inProg) {
      try {
        await setStatus(taskId, inProg);
      } catch {
        /* non-fatal */
      }
    }

    // 3. Run the agent to completion.
    let exitCode: number | null = null;
    let transcript: Transcript = [];
    control.currentRunId = runIdFor(taskId, i);
    try {
      const res = await runAgentToCompletion({
        runId: control.currentRunId,
        prompt: config.basePrompt,
        cwd: config.cwd,
        permissionMode: config.permissionMode,
        appendSystemPrompt: context,
        model: config.model || null,
        effort: config.effort || null,
        onState: (s: AgentState) => callbacks.onItem(i, { transcript: s.transcript }),
      });
      exitCode = res.exitCode;
      transcript = res.transcript;
    } catch (e) {
      control.currentRunId = null;
      const error = `Agent failed to run: ${toMessage(e)}`;
      callbacks.onItem(i, { state: "failed", error });
      callbacks.onHalt(i, error);
      return;
    }
    control.currentRunId = null;

    if (control.stopped) {
      callbacks.onItem(i, { state: "failed", error: "Stopped by user.", transcript });
      return;
    }
    if (exitCode !== 0) {
      const error = `Claude exited with code ${exitCode ?? "?"}.`;
      callbacks.onItem(i, { state: "failed", error, transcript });
      callbacks.onHalt(i, error);
      return;
    }

    const summary = lastAssistantText(transcript) || "(agent returned no summary)";

    // 4. Verify (the gate): only a clean exit lets the ticket succeed.
    if (config.verifyCommand.trim()) {
      callbacks.onItem(i, { state: "verifying", transcript });
      let verifyOk = false;
      let verifyOut = "";
      try {
        const r = await runVerify(config.cwd, config.verifyCommand);
        verifyOk = r.exitCode === 0;
        verifyOut = r.output;
      } catch (e) {
        verifyOut = toMessage(e);
      }
      if (!verifyOk) {
        const error = `Verification failed (\`${config.verifyCommand}\`).`;
        await postComment(
          taskId,
          `⚠️ Claude attempted this ticket but verification failed (\`${config.verifyCommand}\`):\n\n${summary}\n\n---\n${clip(verifyOut)}`,
        );
        callbacks.onItem(i, { state: "failed", error: `${error}\n${clip(verifyOut)}`, summary, transcript });
        callbacks.onHalt(i, error);
        return;
      }
    }

    // 5. Success: set the done status + post a summary comment.
    const done = await resolveStatus(listId, config.doneStatus);
    if (done) {
      try {
        await setStatus(taskId, done);
      } catch {
        /* the work + comment still stand even if the status write fails */
      }
    }
    const verifyNote = config.verifyCommand.trim()
      ? `\n\n✅ Verify (\`${config.verifyCommand}\`) passed.`
      : "";
    await postComment(taskId, `🤖 Claude worked this ticket:\n\n${summary}${verifyNote}`);
    callbacks.onItem(i, { state: "succeeded", summary, transcript });
  }
  callbacks.onDone();
}
