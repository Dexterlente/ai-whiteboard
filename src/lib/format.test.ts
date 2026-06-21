import { describe, it, expect } from "vitest";
import { groupAndSortTasks, relativeDate, isOverdue, initials } from "./format";
import type { ClickUpTask } from "./clickup";

const t = (over: Partial<ClickUpTask>): ClickUpTask => ({
  id: "1",
  name: "x",
  status: "to do",
  statusColor: null,
  statusType: "open",
  statusOrderindex: 0,
  dueDate: null,
  startDate: null,
  url: null,
  listId: null,
  listName: null,
  priority: null,
  priorityColor: null,
  assignees: [],
  tags: [],
  markdownDescription: null,
  textDescription: null,
  ...over,
});

describe("groupAndSortTasks", () => {
  it("floats In Progress to the top, then orders open<done<closed", () => {
    const groups = groupAndSortTasks([
      t({ id: "a", status: "done", statusType: "done", statusOrderindex: 9 }),
      t({ id: "b", status: "to do", statusType: "open", statusOrderindex: 0 }),
      t({ id: "c", status: "in progress", statusType: "custom", statusOrderindex: 1 }),
      t({ id: "d", status: "to do", statusType: "open", statusOrderindex: 0 }),
    ]);
    expect(groups.map((g) => g.status)).toEqual(["in progress", "to do", "done"]);
    expect(groups[0].status).toBe("in progress");
    expect(groups[1].tasks.map((x) => x.id)).toEqual(["b", "d"]); // "to do" tasks grouped
  });

  it("falls back to a 'no status' group", () => {
    const groups = groupAndSortTasks([t({ id: "a", status: "" })]);
    expect(groups[0].status).toBe("no status");
  });
});

describe("relativeDate", () => {
  const now = Date.UTC(2026, 5, 21, 12, 0, 0);
  it("labels today/tomorrow/yesterday and relative days", () => {
    expect(relativeDate(now, now)).toBe("Today");
    expect(relativeDate(now + 86400000, now)).toBe("Tomorrow");
    expect(relativeDate(now - 86400000, now)).toBe("Yesterday");
    expect(relativeDate(now + 3 * 86400000, now)).toBe("in 3d");
    expect(relativeDate(now - 3 * 86400000, now)).toBe("3d ago");
  });

  it("buckets by LOCAL calendar day, not UTC", () => {
    // Same local day, different hours → still "Today" regardless of the runner's timezone.
    const noon = new Date(2026, 5, 21, 12, 0, 0).getTime();
    const evening = new Date(2026, 5, 21, 23, 0, 0).getTime();
    const nextMorning = new Date(2026, 5, 22, 1, 0, 0).getTime();
    expect(relativeDate(evening, noon)).toBe("Today");
    expect(relativeDate(nextMorning, noon)).toBe("Tomorrow");
  });
});

describe("isOverdue", () => {
  const now = Date.UTC(2026, 5, 21, 12, 0, 0);
  it("is true for past due on non-done tasks, false when done/closed/future", () => {
    expect(isOverdue(now - 1000, now, "open")).toBe(true);
    expect(isOverdue(now + 1000, now, "open")).toBe(false);
    expect(isOverdue(now - 1000, now, "done")).toBe(false);
    expect(isOverdue(now - 1000, now, "closed")).toBe(false);
  });
});

describe("initials", () => {
  it("takes up to two leading letters", () => {
    expect(initials("Alice Wonder")).toBe("AW");
    expect(initials("bob")).toBe("B");
    expect(initials("")).toBe("?");
  });
});
