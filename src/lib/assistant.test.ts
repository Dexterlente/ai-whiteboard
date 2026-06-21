import { describe, it, expect } from "vitest";
import { toAssistantReply, buildSystemPrompt, buildUserPrompt, type ChatTurn } from "./assistant";
import type { ClickUpTask, Comment } from "./clickup";

const task = (over: Partial<ClickUpTask> = {}): ClickUpTask => ({
  id: "1",
  name: "Fix login",
  status: "to do",
  statusColor: null,
  statusType: "open",
  statusOrderindex: 0,
  dueDate: null,
  startDate: null,
  url: null,
  listId: "L1",
  listName: "Sprint",
  priority: "high",
  priorityColor: null,
  assignees: [{ username: "alice", color: null, initials: null }],
  tags: [],
  markdownDescription: "Users can't log in",
  textDescription: null,
  ...over,
});

describe("toAssistantReply", () => {
  it("keeps valid actions and the reply", () => {
    const r = toAssistantReply({
      reply: "ok",
      actions: [
        { type: "comment", text: "hi" },
        { type: "set_status", status: "in progress" },
        { type: "create_subtask", name: "Write tests", description: "unit" },
        { type: "set_priority", priority: "urgent" },
        { type: "set_due_date", date: "2026-06-30" },
      ],
    });
    expect(r.reply).toBe("ok");
    expect(r.actions).toHaveLength(5);
  });

  it("drops malformed/unknown actions and coerces a non-string reply", () => {
    const r = toAssistantReply({
      reply: 123,
      actions: [
        { type: "comment", text: "   " }, // blank
        { type: "set_status" }, // missing status
        { type: "create_subtask", name: "" }, // blank name
        { type: "set_priority", priority: "huge" }, // invalid enum
        { type: "set_due_date", date: "June 30" }, // wrong format
        { type: "frobnicate", x: 1 }, // unknown type
        null,
      ],
    });
    expect(r.reply).toBe("");
    expect(r.actions).toEqual([]);
  });

  it("defaults actions to [] when absent", () => {
    expect(toAssistantReply({ reply: "x" })).toEqual({ reply: "x", actions: [] });
  });

  it("drops a blank create_subtask description", () => {
    const r = toAssistantReply({
      reply: "",
      actions: [{ type: "create_subtask", name: "A", description: "  " }],
    });
    expect(r.actions[0]).toEqual({ type: "create_subtask", name: "A", description: undefined });
  });
});

describe("buildSystemPrompt", () => {
  it("includes ticket context, valid statuses, and the never-claim-applied guardrail", () => {
    const comments: Comment[] = [
      { id: "c1", text: "any update?", author: "bob", authorColor: null, authorInitials: null, date: null },
    ];
    const s = buildSystemPrompt(task(), null, comments, "2026-06-21", ["to do", "in progress", "done"]);
    expect(s).toContain("Fix login");
    expect(s).toContain("alice");
    expect(s).toContain("bob: any update?");
    expect(s).toContain("Valid statuses for this ticket: to do, in progress, done");
    expect(s).toContain("must click");
    expect(s).toContain("Today's date is 2026-06-21");
  });

  it("prefers detail over the list task for the description", () => {
    const s = buildSystemPrompt(task({ markdownDescription: null }), task({ markdownDescription: "FULL" }), [], "2026-06-21");
    expect(s).toContain("FULL");
  });
});

describe("buildUserPrompt", () => {
  it("includes prior turns and the new message", () => {
    const history: ChatTurn[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    const p = buildUserPrompt(history, "summarize");
    expect(p).toContain("User: hi");
    expect(p).toContain("Assistant: hello");
    expect(p).toContain("User: summarize");
  });

  it("omits the transcript header on the first message", () => {
    expect(buildUserPrompt([], "first")).not.toContain("Conversation so far");
  });
});
