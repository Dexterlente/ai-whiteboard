import { invoke } from "@tauri-apps/api/core";

/** A ClickUp assignee (keys match the Rust `Assignee` struct). */
export type Assignee = { username: string; color: string | null; initials: string | null };

/** A ClickUp tag (keys match the Rust `Tag` struct). */
export type Tag = { name: string; fg: string | null; bg: string | null };

/** A ClickUp task (keys match the Rust `Task` struct, camelCase). */
export type ClickUpTask = {
  id: string;
  name: string;
  status: string;
  statusColor: string | null;
  statusType: string | null;
  statusOrderindex: number | null;
  dueDate: string | null; // ms-epoch string
  startDate: string | null; // ms-epoch string
  url: string | null;
  listId: string | null; // needed to create subtasks
  listName: string | null;
  priority: string | null; // "urgent" | "high" | "normal" | "low"
  priorityColor: string | null;
  assignees: Assignee[];
  tags: Tag[];
  markdownDescription: string | null; // populated only by fetchTaskDetail
  textDescription: string | null;
};

/** A task comment (keys match the Rust `Comment` struct). */
export type Comment = {
  id: string;
  text: string;
  author: string;
  authorColor: string | null;
  authorInitials: string | null;
  date: string | null; // ms-epoch string
};

/** Fetch every open task assigned to me, across all workspaces. */
/** Extract a ClickUp task id from a pasted task URL or a bare id. */
export function parseTaskId(input: string): string {
  const s = input.trim();
  const m = s.match(/\/t\/([^/?#]+)/); // https://app.clickup.com/t/<id>
  return (m ? m[1] : s.replace(/^#/, "")).trim();
}

export const fetchMyTasks = () => invoke<ClickUpTask[]>("fetch_my_clickup_tasks");

/** Fetch a single task with its full markdown description. */
export const fetchTaskDetail = (taskId: string) =>
  invoke<ClickUpTask>("fetch_clickup_task", { taskId });

/** Fetch a task's comments (read-only). */
export const fetchComments = (taskId: string) =>
  invoke<Comment[]>("fetch_clickup_comments", { taskId });

/** The status names available in a list (for proposing a valid status). */
export const fetchListStatuses = (listId: string) =>
  invoke<string[]>("fetch_list_statuses", { listId });

/** Open an http(s) URL in the default browser. */
export const openExternal = (url: string) => invoke("open_external", { url });

/** Save a task's drawing-board scene. */
export const saveTaskScene = (taskId: string, json: string) =>
  invoke("save_task_scene", { taskId, json });

/** Load a task's drawing-board scene ("" when none). */
export const loadTaskScene = (taskId: string) =>
  invoke<string>("load_task_scene", { taskId });

/** Persist the ClickUp personal token (pk_...). */
export const saveToken = (token: string) => invoke("save_clickup_token", { token });

/** Load the saved token (empty string when unset). */
export const loadToken = () => invoke<string>("load_clickup_token");

// --- Writes (setStatus drives the status picker; the others are wrappers kept for manual controls) ---

/** Map ClickUp priority words to their integer codes (1=urgent … 4=low). */
export const PRIORITY_INT: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

/** Add a comment to a task. */
export const addComment = (taskId: string, text: string) =>
  invoke("clickup_add_comment", { taskId, text });

/** Change a task's status. */
export const setStatus = (taskId: string, status: string) =>
  invoke("clickup_set_status", { taskId, status });

/** Set a task's priority (1=urgent … 4=low). */
export const setPriority = (taskId: string, priority: number) =>
  invoke("clickup_set_priority", { taskId, priority });

/** Set a task's due date (ms-epoch). */
export const setDueDate = (taskId: string, dueDate: number) =>
  invoke("clickup_set_due_date", { taskId, dueDate });

/** Create a subtask under `parentId` in `listId`; resolves to the new task id. */
export const createSubtask = (
  listId: string,
  parentId: string,
  name: string,
  description?: string,
) => invoke<string>("clickup_create_subtask", { listId, parentId, name, description: description ?? null });
