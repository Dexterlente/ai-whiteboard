import { invoke } from "@tauri-apps/api/core";

/** A ClickUp task assigned to the authenticated user (keys match the Rust `Task` struct). */
export type ClickUpTask = {
  id: string;
  name: string;
  status: string;
  statusColor: string | null;
  dueDate: string | null; // ms-epoch string, or null
  url: string | null;
  listName: string | null;
};

/** Fetch every open task assigned to me, across all workspaces. */
export function fetchMyTasks(): Promise<ClickUpTask[]> {
  return invoke<ClickUpTask[]>("fetch_my_clickup_tasks");
}

/** Persist the ClickUp personal token (pk_...). */
export function saveToken(token: string): Promise<void> {
  return invoke("save_clickup_token", { token });
}

/** Load the saved token (empty string when unset). */
export function loadToken(): Promise<string> {
  return invoke<string>("load_clickup_token");
}
