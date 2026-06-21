import type { ClickUpTask } from "./clickup";

/** Tasks sharing a status, in display order. */
export type StatusGroup = { status: string; color: string | null; tasks: ClickUpTask[] };

const DAY = 86_400_000;

// Open/custom statuses come first, then "done", then "closed".
function typeRank(type: string | null): number {
  if (type === "closed") return 2;
  if (type === "done") return 1;
  return 0;
}

// "In Progress" statuses float to the very top; everything else by workflow type.
function groupRank(status: string, type: string | null): number {
  return status.toLowerCase().includes("progress") ? -1 : typeRank(type);
}

/** Group tasks by status name and order groups by workflow position. */
export function groupAndSortTasks(tasks: ClickUpTask[]): StatusGroup[] {
  const order: string[] = [];
  const map = new Map<string, StatusGroup>();
  const meta = new Map<string, { rank: number; idx: number }>();
  for (const task of tasks) {
    const key = task.status || "no status";
    if (!map.has(key)) {
      map.set(key, { status: key, color: task.statusColor, tasks: [] });
      meta.set(key, { rank: groupRank(key, task.statusType), idx: task.statusOrderindex ?? 0 });
      order.push(key);
    }
    map.get(key)!.tasks.push(task);
  }
  order.sort((a, b) => {
    const ma = meta.get(a)!;
    const mb = meta.get(b)!;
    return ma.rank - mb.rank || ma.idx - mb.idx || a.localeCompare(b);
  });
  return order.map((k) => map.get(k)!);
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A short, human relative-day label ("Today", "in 3d", "3d ago"), by local day. */
export function relativeDate(ms: number, now: number): string {
  // round (not floor) so DST 23h/25h days still bucket to whole days.
  const days = Math.round((startOfLocalDay(ms) - startOfLocalDay(now)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 0) return `in ${days}d`;
  return `${-days}d ago`;
}

/** A due date is overdue only when it's past and the task isn't done/closed. */
export function isOverdue(dueMs: number, now: number, statusType: string | null): boolean {
  if (statusType === "done" || statusType === "closed") return false;
  return dueMs < now;
}

/** Up to two leading letters of a name, uppercased ("Alice Wonder" → "AW"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0]!.toUpperCase();
  return (parts[0][0]! + parts[parts.length - 1][0]!).toUpperCase();
}
