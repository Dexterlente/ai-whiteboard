import { invoke } from "@tauri-apps/api/core";
import { findJsonObject } from "./json";
import type { ClickUpTask, Comment } from "./clickup";

export type AssistantAction =
  | { type: "comment"; text: string }
  | { type: "set_status"; status: string }
  | { type: "create_subtask"; name: string; description?: string }
  | { type: "set_priority"; priority: "urgent" | "high" | "normal" | "low" }
  | { type: "set_due_date"; date: string };

export type AssistantReply = { reply: string; actions: AssistantAction[] };
export type ChatTurn = { role: "user" | "assistant"; text: string };
export type ClaudeStatus = { installed: boolean; path: string | null };
export type ClaudeTest = { ok: boolean; detail: string };

export const claudeStatus = () => invoke<ClaudeStatus>("claude_status");
export const claudeTestConnection = () => invoke<ClaudeTest>("claude_test_connection");

const PRIORITIES = new Set(["urgent", "high", "normal", "low"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate/normalize one parsed object into an AssistantReply, dropping any malformed or
 * unknown action so nothing unexpected ever reaches a ClickUp write.
 */
export function toAssistantReply(parsed: any): AssistantReply {
  const reply = typeof parsed?.reply === "string" ? parsed.reply : "";
  const rawActions = Array.isArray(parsed?.actions) ? parsed.actions : [];
  const actions: AssistantAction[] = [];
  for (const a of rawActions) {
    if (!a || typeof a !== "object") continue;
    switch (a.type) {
      case "comment":
        if (typeof a.text === "string" && a.text.trim()) actions.push({ type: "comment", text: a.text });
        break;
      case "set_status":
        if (typeof a.status === "string" && a.status.trim())
          actions.push({ type: "set_status", status: a.status });
        break;
      case "create_subtask":
        if (typeof a.name === "string" && a.name.trim()) {
          actions.push({
            type: "create_subtask",
            name: a.name,
            description:
              typeof a.description === "string" && a.description.trim() ? a.description : undefined,
          });
        }
        break;
      case "set_priority":
        if (typeof a.priority === "string" && PRIORITIES.has(a.priority))
          actions.push({ type: "set_priority", priority: a.priority });
        break;
      case "set_due_date":
        if (typeof a.date === "string" && ISO_DATE.test(a.date))
          actions.push({ type: "set_due_date", date: a.date });
        break;
    }
  }
  return { reply, actions };
}

/** Ask Claude about a ticket; returns the validated reply + proposed actions. */
export async function askClaude(system: string, prompt: string): Promise<AssistantReply> {
  const raw = await invoke<string>("claude_ask", { systemPrompt: system, prompt });
  const envelope = JSON.parse(raw) as { is_error?: boolean; result?: string };
  if (envelope.is_error || envelope.result == null) {
    throw new Error(envelope.result ?? "claude returned no result");
  }
  const obj = findJsonObject(
    envelope.result,
    (o) => typeof o.reply === "string" || Array.isArray(o.actions),
  );
  if (!obj) throw new Error("Claude did not return a usable response — try rephrasing");
  return toAssistantReply(obj);
}

/** Build the per-call system prompt: ticket context + strict output rules. */
export function buildSystemPrompt(
  task: ClickUpTask,
  detail: ClickUpTask | null,
  comments: Comment[],
  today: string,
  statuses?: string[],
): string {
  const d = detail ?? task;
  const description = d.markdownDescription || d.textDescription || "(none)";
  const assignees = d.assignees.length ? d.assignees.map((a) => a.username).join(", ") : "none";
  const commentLines = comments.length
    ? comments.map((c) => `  - ${c.author || "Unknown"}: ${c.text}`).join("\n")
    : "  (none)";
  const statusLine =
    statuses && statuses.length ? `\nValid statuses for this ticket: ${statuses.join(", ")}` : "";
  return [
    "You are a helpful assistant embedded in a desktop app, attached to a single ClickUp ticket.",
    "",
    `Today's date is ${today}.`,
    "",
    "TICKET CONTEXT:",
    `- Title: ${d.name}`,
    `- Status: ${d.status || "(none)"}`,
    `- Priority: ${d.priority || "none"}`,
    `- List: ${d.listName || "(none)"}`,
    `- Assignees: ${assignees}`,
    "- Description:",
    description,
    `- Comments (${comments.length}):`,
    commentLines + statusLine,
    "",
    'Help the user understand and make progress on this ticket. Be concise; use markdown in "reply".',
    "",
    "You may PROPOSE write-actions, but you can NEVER perform them yourself: the user must click",
    "Apply in the app for anything to happen. Never say an action is done, applied, created, or",
    "changed — only that you are proposing it. Only propose an action when the user clearly wants it.",
    "For set_status, use one of the valid statuses above (case-insensitive) when they are listed.",
    "",
    "Respond with ONLY one JSON object, no prose outside it and no markdown code fences:",
    '{ "reply": string, "actions": [ ... ] }',
    "Each action is one of:",
    '  { "type": "comment", "text": string }',
    '  { "type": "set_status", "status": string }',
    '  { "type": "create_subtask", "name": string, "description"?: string }',
    '  { "type": "set_priority", "priority": "urgent"|"high"|"normal"|"low" }',
    '  { "type": "set_due_date", "date": "YYYY-MM-DD" }',
    'If you have nothing to propose, use "actions": [].',
  ].join("\n");
}

/** Build the user-turn prompt: prior transcript + the new message. */
export function buildUserPrompt(history: ChatTurn[], message: string): string {
  const convo = history.length
    ? "Conversation so far:\n" +
      history.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n") +
      "\n\n"
    : "";
  return `${convo}User: ${message}\n\nRespond to the latest user message as the JSON object described above.`;
}

/**
 * Compact ticket context prepended to a diagram-generation prompt so Claude grounds the
 * flowchart in THIS ticket (title + description + a few comments) instead of guessing from
 * the bare phrase. Description is trimmed to keep the prompt small.
 */
export function buildDiagramContext(
  task: ClickUpTask,
  detail: ClickUpTask | null,
  comments: Comment[],
): string {
  const d = detail ?? task;
  const raw = (d.markdownDescription || d.textDescription || "").trim();
  const description = raw.length > 1500 ? raw.slice(0, 1500) + "…" : raw || "(none)";
  const recent = comments.slice(-5);
  const commentLines = recent.length
    ? recent.map((c) => `  - ${c.author || "Unknown"}: ${c.text}`).join("\n")
    : "  (none)";
  return [
    "TICKET CONTEXT (ground the diagram in this when relevant):",
    `- Title: ${d.name}`,
    "- Description:",
    description,
    `- Recent comments (${recent.length} of ${comments.length}):`,
    commentLines,
  ].join("\n");
}

/**
 * Ticket context for the AGENT mode (full Claude Code in a work folder). Same ticket data as
 * `buildSystemPrompt` but WITHOUT the strict-JSON output rules — the agent replies naturally
 * and uses its tools.
 */
export function buildAgentTicketContext(
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
    "You are attached to a ClickUp ticket while working in the user's project folder.",
    `Today's date is ${today}.`,
    "",
    "TICKET CONTEXT:",
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
    "Use this ticket as the context for the user's requests. You have full tool access in the working folder.",
  ].join("\n");
}
