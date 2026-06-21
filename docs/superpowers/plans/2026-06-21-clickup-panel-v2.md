# ClickUp Panel v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the ClickUp side panel into a polished, color-refined task browser: tasks grouped into collapsible status sections, a slide-over drawer showing the full ticket (rendered markdown description + comments + "Open in ClickUp"), and a persisted per-task Excalidraw drawing board.

**Architecture:** Rust commands own all ClickUp HTTP and local file I/O (token, per-task scenes) and normalize responses to camelCase structs. The React panel is decomposed into small focused components (`TaskRow`, `StatusGroup`, `TaskPanel`, `TaskDrawer`) sharing a design-token module (`ui.ts`). Pure presentation logic (grouping, sorting, relative dates, initials) lives in `format.ts` and is unit-tested with vitest. Markdown is rendered with `marked` and sanitized with `dompurify`.

**Tech Stack:** Tauri v2 (Rust + reqwest/rustls), React 19 + TypeScript, Excalidraw, marked + dompurify, vitest.

## Global Constraints

- ClickUp auth header is `Authorization: <pk_token>` (no `Bearer`). Reuse existing `read_token` / `check_status` / `net_err` helpers in `src-tauri/src/lib.rs`.
- All ms-epoch timestamps arrive from ClickUp as **strings or null**.
- Rust→TS field names use `#[serde(rename_all = "camelCase")]`; TS types must match exactly.
- No new Tauri capability/plugin needed: "Open in ClickUp" uses a Rust `open_external` command that shells out (matches the existing `Command`-based `claude` pattern), not the opener plugin.
- Per-task scene files: `~/.ai-whiteboard/tasks/{task_id}.json`; `task_id` must be validated (ascii alnum / `-` / `_`) to prevent path traversal.
- Keep the existing whiteboard ("generate diagram") behavior untouched.

---

## File structure

**Backend**
- Modify `src-tauri/src/lib.rs` — enrich `Task`, add `fetch_clickup_task`, `fetch_clickup_comments`, `open_external`, `save_task_scene`, `load_task_scene`; register all in the handler.

**Frontend libs**
- Modify `src/lib/clickup.ts` — extend `ClickUpTask`, add `Comment`, add wrappers.
- Create `src/lib/format.ts` — pure helpers (tested).
- Create `src/lib/markdown.ts` — `renderMarkdown` (marked + dompurify).
- Create `src/lib/format.test.ts` — vitest unit tests.

**Frontend components**
- Create `src/components/ui.ts` — design tokens + small style helpers.
- Create `src/components/TaskRow.tsx` — one task row.
- Create `src/components/StatusGroup.tsx` — a collapsible status section.
- Create `src/components/TaskDrawer.tsx` — slide-over detail + board.
- Modify `src/components/TaskPanel.tsx` — groups + selection + renders drawer.
- Modify `src/App.tsx` + `src/App.css` — color refresh, primary button styling.

**Config**
- Modify `package.json` — add deps (`marked`, `dompurify`), devDeps (`vitest`), `test` script.
- Create `vitest.config.ts` — node test env (keeps the Tauri-tailored vite config untouched).

---

## Task A: Backend — enrich tasks + detail/comments/board/open commands

**Files:** Modify `src-tauri/src/lib.rs`

**Interfaces produced (TS-visible via serde camelCase):**
- `Task { id, name, status, statusColor, statusType, statusOrderindex, dueDate, startDate, url, listName, priority, priorityColor, assignees: Assignee[], tags: Tag[], markdownDescription, textDescription }`
- `Assignee { username, color, initials }`, `Tag { name, fg, bg }`
- `Comment { id, text, author, authorColor, authorInitials, date }`
- Commands: `fetch_my_clickup_tasks() -> Vec<Task>`, `fetch_clickup_task(task_id) -> Task`, `fetch_clickup_comments(task_id) -> Vec<Comment>`, `open_external(url)`, `save_task_scene(task_id, json)`, `load_task_scene(task_id) -> String`.

- [ ] **Step 1:** Add a tolerant numeric deserializer (ClickUp sometimes sends numbers as strings):

```rust
fn de_opt_i64<'de, D>(d: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    Ok(Option::<serde_json::Value>::deserialize(d)?.and_then(|v| match v {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    }))
}
```

- [ ] **Step 2:** Replace `RawStatus` / `RawTask` / `Task` with the enriched versions and add `RawPriority`, `RawAssignee`, `RawTag`, `Assignee`, `Tag`. `RawTask` carries optional `markdown_description`/`text_content` (absent in list responses) so one `normalize` serves both list and detail:

```rust
#[derive(serde::Deserialize)]
struct RawStatus {
    status: String,
    #[serde(default)] color: Option<String>,
    #[serde(rename = "type", default)] kind: Option<String>,
    #[serde(default, deserialize_with = "de_opt_i64")] orderindex: Option<i64>,
}
#[derive(serde::Deserialize)]
struct RawPriority {
    #[serde(default)] priority: Option<String>,
    #[serde(default)] color: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawAssignee {
    #[serde(default)] username: Option<String>,
    #[serde(default)] color: Option<String>,
    #[serde(default)] initials: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawTag {
    name: String,
    #[serde(default)] tag_fg: Option<String>,
    #[serde(default)] tag_bg: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawTask {
    id: String,
    name: String,
    status: Option<RawStatus>,
    #[serde(default)] due_date: Option<String>,
    #[serde(default)] start_date: Option<String>,
    #[serde(default)] url: Option<String>,
    list: Option<RawList>,
    priority: Option<RawPriority>,
    #[serde(default)] assignees: Vec<RawAssignee>,
    #[serde(default)] tags: Vec<RawTag>,
    #[serde(default)] markdown_description: Option<String>,
    #[serde(default)] text_content: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Assignee { username: String, color: Option<String>, initials: Option<String> }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Tag { name: String, fg: Option<String>, bg: Option<String> }

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    name: String,
    status: String,
    status_color: Option<String>,
    status_type: Option<String>,
    status_orderindex: Option<i64>,
    due_date: Option<String>,
    start_date: Option<String>,
    url: Option<String>,
    list_name: Option<String>,
    priority: Option<String>,
    priority_color: Option<String>,
    assignees: Vec<Assignee>,
    tags: Vec<Tag>,
    markdown_description: Option<String>,
    text_description: Option<String>,
}

fn normalize(t: RawTask) -> Task {
    let (status, status_color, status_type, status_orderindex) = match t.status {
        Some(s) => (s.status, s.color, s.kind, s.orderindex),
        None => (String::new(), None, None, None),
    };
    let (priority, priority_color) = match t.priority {
        Some(p) => (p.priority, p.color),
        None => (None, None),
    };
    Task {
        id: t.id,
        name: t.name,
        status,
        status_color,
        status_type,
        status_orderindex,
        due_date: t.due_date,
        start_date: t.start_date,
        url: t.url,
        list_name: t.list.and_then(|l| l.name),
        priority,
        priority_color,
        assignees: t.assignees.into_iter().map(|a| Assignee {
            username: a.username.unwrap_or_default(),
            color: a.color,
            initials: a.initials,
        }).collect(),
        tags: t.tags.into_iter().map(|t| Tag { name: t.name, fg: t.tag_fg, bg: t.tag_bg }).collect(),
        markdown_description: t.markdown_description,
        text_description: t.text_content,
    }
}
```

- [ ] **Step 3:** Update `fetch_my_clickup_tasks`'s task loop to push `normalize(t)` instead of the inline `Task { ... }` construction (replaces the `let (status, status_color) = ...` block).

- [ ] **Step 4:** Add the detail + comments commands (reuse `read_token`, `check_status`, `net_err`):

```rust
async fn authed_get<T: serde::de::DeserializeOwned>(url: &str, what: &str) -> Result<T, String> {
    let token = read_token()?.ok_or("No ClickUp token saved. Add one in Settings.")?;
    let resp = check_status(
        reqwest::Client::new().get(url).header("Authorization", token).send().await.map_err(net_err)?,
        what,
    )?;
    resp.json::<T>().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_clickup_task(task_id: String) -> Result<Task, String> {
    let url = format!(
        "https://api.clickup.com/api/v2/task/{task_id}?include_markdown_description=true"
    );
    let raw: RawTask = authed_get(&url, "task").await?;
    Ok(normalize(raw))
}

#[derive(serde::Deserialize)]
struct CommentsResponse { comments: Vec<RawComment> }
#[derive(serde::Deserialize)]
struct RawComment {
    id: String,
    #[serde(default)] comment_text: Option<String>,
    user: Option<RawCommentUser>,
    #[serde(default)] date: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawCommentUser {
    #[serde(default)] username: Option<String>,
    #[serde(default)] color: Option<String>,
    #[serde(default)] initials: Option<String>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Comment {
    id: String,
    text: String,
    author: String,
    author_color: Option<String>,
    author_initials: Option<String>,
    date: Option<String>,
}

#[tauri::command]
async fn fetch_clickup_comments(task_id: String) -> Result<Vec<Comment>, String> {
    let url = format!("https://api.clickup.com/api/v2/task/{task_id}/comment");
    let body: CommentsResponse = authed_get(&url, "comments").await?;
    Ok(body.comments.into_iter().map(|c| {
        let (author, author_color, author_initials) = match c.user {
            Some(u) => (u.username.unwrap_or_default(), u.color, u.initials),
            None => (String::new(), None, None),
        };
        Comment { id: c.id, text: c.comment_text.unwrap_or_default(), author, author_color, author_initials, date: c.date }
    }).collect())
}
```

- [ ] **Step 5:** Add `open_external` (http/https only) + per-task scene I/O:

```rust
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Refusing to open a non-http URL".into());
    }
    #[cfg(target_os = "linux")] let program = "xdg-open";
    #[cfg(target_os = "macos")] let program = "open";
    #[cfg(target_os = "windows")] let program = "explorer";
    Command::new(program).arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn task_scene_path(task_id: &str) -> Result<PathBuf, String> {
    if task_id.is_empty()
        || !task_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid task id".into());
    }
    let dir = data_dir()?.join("tasks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{task_id}.json")))
}

#[tauri::command]
fn save_task_scene(task_id: String, json: String) -> Result<(), String> {
    std::fs::write(task_scene_path(&task_id)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_task_scene(task_id: String) -> Result<String, String> {
    match std::fs::read_to_string(task_scene_path(&task_id)?) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()), // no board yet
    }
}
```

- [ ] **Step 6:** Add all new commands to `tauri::generate_handler![...]`: `fetch_clickup_task, fetch_clickup_comments, open_external, save_task_scene, load_task_scene`.

- [ ] **Step 7:** `cd src-tauri && cargo build` → expect success, no warnings.

---

## Task B: `format.ts` pure helpers (TDD)

**Files:** Create `src/lib/format.ts`, `src/lib/format.test.ts`, `vitest.config.ts`; modify `package.json`.

**Interfaces produced:**
- `type StatusGroup = { status: string; color: string | null; tasks: ClickUpTask[] }`
- `groupAndSortTasks(tasks: ClickUpTask[]): StatusGroup[]`
- `relativeDate(ms: number, now: number): string`
- `isOverdue(dueMs: number, now: number, statusType: string | null): boolean`
- `initials(name: string): string`

- [ ] **Step 1:** Add vitest + scripts. In `package.json` add devDep `"vitest": "^2"` and script `"test": "vitest run"`. Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

- [ ] **Step 2:** Write `src/lib/format.test.ts` (failing):

```ts
import { describe, it, expect } from "vitest";
import { groupAndSortTasks, relativeDate, isOverdue, initials } from "./format";
import type { ClickUpTask } from "./clickup";

const t = (over: Partial<ClickUpTask>): ClickUpTask => ({
  id: "1", name: "x", status: "to do", statusColor: null, statusType: "open",
  statusOrderindex: 0, dueDate: null, startDate: null, url: null, listName: null,
  priority: null, priorityColor: null, assignees: [], tags: [],
  markdownDescription: null, textDescription: null, ...over,
});

describe("groupAndSortTasks", () => {
  it("groups by status and orders open<done<closed then orderindex", () => {
    const groups = groupAndSortTasks([
      t({ id: "a", status: "done", statusType: "done", statusOrderindex: 9 }),
      t({ id: "b", status: "to do", statusType: "open", statusOrderindex: 0 }),
      t({ id: "c", status: "in progress", statusType: "custom", statusOrderindex: 1 }),
      t({ id: "d", status: "to do", statusType: "open", statusOrderindex: 0 }),
    ]);
    expect(groups.map((g) => g.status)).toEqual(["to do", "in progress", "done"]);
    expect(groups[0].tasks.map((x) => x.id)).toEqual(["b", "d"]);
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
});

describe("isOverdue", () => {
  const now = Date.UTC(2026, 5, 21, 12, 0, 0);
  it("is true for past due on non-done tasks, false when done", () => {
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
```

- [ ] **Step 3:** Run `npm test` → expect FAIL (module not found).

- [ ] **Step 4:** Implement `src/lib/format.ts`:

```ts
import type { ClickUpTask } from "./clickup";

export type StatusGroup = { status: string; color: string | null; tasks: ClickUpTask[] };

const DAY = 86_400_000;
// open/custom statuses first, then done, then closed.
function typeRank(type: string | null): number {
  if (type === "closed") return 2;
  if (type === "done") return 1;
  return 0;
}

export function groupAndSortTasks(tasks: ClickUpTask[]): StatusGroup[] {
  const order: string[] = [];
  const map = new Map<string, StatusGroup>();
  const meta = new Map<string, { rank: number; idx: number }>();
  for (const task of tasks) {
    const key = task.status || "no status";
    if (!map.has(key)) {
      map.set(key, { status: key, color: task.statusColor, tasks: [] });
      meta.set(key, { rank: typeRank(task.statusType), idx: task.statusOrderindex ?? 0 });
      order.push(key);
    }
    map.get(key)!.tasks.push(task);
  }
  order.sort((a, b) => {
    const ma = meta.get(a)!, mb = meta.get(b)!;
    return ma.rank - mb.rank || ma.idx - mb.idx || a.localeCompare(b);
  });
  return order.map((k) => map.get(k)!);
}

export function relativeDate(ms: number, now: number): string {
  const startOf = (n: number) => Math.floor(n / DAY);
  const days = startOf(ms) - startOf(now);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 0) return `in ${days}d`;
  return `${-days}d ago`;
}

export function isOverdue(dueMs: number, now: number, statusType: string | null): boolean {
  if (statusType === "done" || statusType === "closed") return false;
  return dueMs < now;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0]!.toUpperCase();
  return (parts[0][0]! + parts[parts.length - 1][0]!).toUpperCase();
}
```

- [ ] **Step 5:** Run `npm test` → expect PASS (all suites green).

---

## Task C: `clickup.ts` — extended types + wrappers

**Files:** Modify `src/lib/clickup.ts`

**Interfaces produced:** `ClickUpTask` (matches Rust `Task`), `Comment`, `Assignee`, `Tag`, and wrappers `fetchMyTasks`, `fetchTaskDetail(id)`, `fetchComments(id)`, `openExternal(url)`, `saveTaskScene(id, json)`, `loadTaskScene(id)`, plus existing `saveToken`/`loadToken`.

- [ ] **Step 1:** Replace the `ClickUpTask` type and add the rest:

```ts
export type Assignee = { username: string; color: string | null; initials: string | null };
export type Tag = { name: string; fg: string | null; bg: string | null };

export type ClickUpTask = {
  id: string;
  name: string;
  status: string;
  statusColor: string | null;
  statusType: string | null;
  statusOrderindex: number | null;
  dueDate: string | null;
  startDate: string | null;
  url: string | null;
  listName: string | null;
  priority: string | null;
  priorityColor: string | null;
  assignees: Assignee[];
  tags: Tag[];
  markdownDescription: string | null;
  textDescription: string | null;
};

export type Comment = {
  id: string;
  text: string;
  author: string;
  authorColor: string | null;
  authorInitials: string | null;
  date: string | null;
};

export const fetchMyTasks = () => invoke<ClickUpTask[]>("fetch_my_clickup_tasks");
export const fetchTaskDetail = (taskId: string) => invoke<ClickUpTask>("fetch_clickup_task", { taskId });
export const fetchComments = (taskId: string) => invoke<Comment[]>("fetch_clickup_comments", { taskId });
export const openExternal = (url: string) => invoke("open_external", { url });
export const saveTaskScene = (taskId: string, json: string) => invoke("save_task_scene", { taskId, json });
export const loadTaskScene = (taskId: string) => invoke<string>("load_task_scene", { taskId });
export const saveToken = (token: string) => invoke("save_clickup_token", { token });
export const loadToken = () => invoke<string>("load_clickup_token");
```

> Note: Tauri maps the JS arg key `taskId` → Rust param `task_id` automatically. Keep the existing `import { invoke } from "@tauri-apps/api/core";`.

---

## Task D: `markdown.ts` + `ui.ts` (design tokens / colors)

**Files:** Create `src/lib/markdown.ts`, `src/components/ui.ts`; modify `package.json` (add deps `marked`, `dompurify`).

- [ ] **Step 1:** `package.json` dependencies add `"marked": "^12"`, `"dompurify": "^3"`. Run `npm install`.

- [ ] **Step 2:** `src/lib/markdown.ts`:

```ts
import { marked } from "marked";
import DOMPurify from "dompurify";

/** Render ClickUp markdown to sanitized HTML (safe to dangerouslySetInnerHTML). */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md ?? "", { async: false }) as string;
  return DOMPurify.sanitize(raw);
}
```

- [ ] **Step 3:** `src/components/ui.ts` — the refreshed palette + tokens (indigo accent, slate neutrals, semantic status/priority colors) and helpers:

```ts
export const colors = {
  bg: "#f7f8fa",
  surface: "#ffffff",
  surfaceAlt: "#f1f3f7",
  border: "#e3e6ec",
  text: "#1f2430",
  textMuted: "#6b7280",
  textFaint: "#9aa1ad",
  accent: "#6366f1",        // indigo-500
  accentHover: "#4f46e5",
  accentSoft: "#eef0ff",
  danger: "#e5484d",
  shadow: "0 6px 24px rgba(20, 23, 33, 0.12)",
};

export const radius = { sm: 6, md: 10, lg: 14, pill: 999 };
export const space = (n: number) => n * 4;

// Fallback color cycle for statuses/avatars that ClickUp didn't color.
const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#e5484d", high: "#f5a623", normal: "#6390f0", low: "#a0a0a0",
};

/** Readable text color (black/white) for a given background hex. */
export function readableOn(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length < 6) return "#fff";
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1f2430" : "#ffffff";
}
```

---

## Task E: `TaskRow` + `StatusGroup`

**Files:** Create `src/components/TaskRow.tsx`, `src/components/StatusGroup.tsx`

**Interfaces produced:**
- `TaskRow({ task, onOpen }: { task: ClickUpTask; onOpen: (t: ClickUpTask) => void })`
- `StatusGroup({ group, defaultOpen, onOpen }: { group: StatusGroupT; defaultOpen: boolean; onOpen: (t: ClickUpTask) => void })`

- [ ] **Step 1:** `TaskRow.tsx` — a pretty row: title (one line, ellipsis), a meta line with priority flag (colored using `PRIORITY_COLOR`), relative due date (red when `isOverdue` using `Date.now()`), assignee initials avatars (colored circles, `initials()` fallback), and tag pills (using `tag.bg`/`tag.fg` or `colorFor`). Hover background `colors.surfaceAlt`, `cursor: pointer`, `onClick={() => onOpen(task)}`. Use `ui.ts` tokens for all colors/spacing.

- [ ] **Step 2:** `StatusGroup.tsx` — header row: colored dot (`group.color || colorFor(group.status)`), uppercase status label, count pill (`group.tasks.length`), and a chevron (▸/▾) that toggles a local `open` state (init from `defaultOpen`). When open, render the group's `TaskRow`s. Header is a `button` (full-width, accessible). Smooth via `transition` on the chevron.

---

## Task F: `TaskPanel` — groups + selection + drawer host

**Files:** Modify `src/components/TaskPanel.tsx`

- [ ] **Step 1:** Keep existing state (`tasks`, `token`, `showSettings`, `loading`, `error`) and the existing `refresh`/`saveAndRefresh`/mount-effect/`toMessage` logic. Add `const [selected, setSelected] = useState<ClickUpTask | null>(null);`.
- [ ] **Step 2:** Replace the flat task list render with `groupAndSortTasks(tasks).map((g, i) => <StatusGroup key={g.status} group={g} defaultOpen={i < 3} onOpen={setSelected} />)`. Keep the loading skeleton / empty / error states (restyled with `ui.ts`).
- [ ] **Step 3:** Restyle the panel header + settings using `ui.ts` tokens (surface, border, accent for "Save & Refresh", icon buttons for ↻/⚙). Widen panel to `320px`.
- [ ] **Step 4:** At the end of the panel JSX render `{selected && <TaskDrawer key={selected.id} task={selected} onClose={() => setSelected(null)} />}`.

---

## Task G: `TaskDrawer` — slide-over with Details + Board tabs

**Files:** Create `src/components/TaskDrawer.tsx`

**Interfaces consumed:** `fetchTaskDetail`, `fetchComments`, `openExternal`, `saveTaskScene`, `loadTaskScene` (clickup.ts); `renderMarkdown` (markdown.ts); `ui.ts`; `Excalidraw`, `serializeAsJSON` from `@excalidraw/excalidraw`.

- [ ] **Step 1:** Props `{ task: ClickUpTask; onClose: () => void }`. State: `detail`, `comments`, `loadingDetail`, `errorDetail`, `tab: "details" | "board"`, `boardMounted` (becomes true the first time the Board tab opens, then stays mounted).
- [ ] **Step 2:** On mount (effect on `task.id`): `Promise.all([fetchTaskDetail(task.id), fetchComments(task.id)])`, populate state, handle error via `toMessage`. Use `task` (the list summary) for instant header while detail loads.
- [ ] **Step 3:** Layout: a fixed full-height backdrop (`rgba(15,18,26,.35)`, click → `onClose`) + a right-anchored drawer `width: min(760px, 70vw)`, `background: colors.surface`, `boxShadow: colors.shadow`, slide-in transition (`transform: translateX(0)` from `100%`). ESC key closes (keydown effect). Header: title + status pill + ✕. Tab bar: Details | Board.
- [ ] **Step 4:** Details tab (scrollable): status pill, priority chip, due/start dates (relative + absolute title), assignee avatars, tag pills, a divider, the rendered markdown (`<div dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.markdownDescription || detail.textDescription || "_No description_") }} />` inside a `.cu-markdown` styled container), a divider, **Comments (n)** each with avatar + author + relative time + text, and a footer **"Open in ClickUp ↗"** button (`onClick={() => task.url && openExternal(task.url)}`).
- [ ] **Step 5:** Board tab — the per-task Excalidraw. Mount lazily once `tab === "board"` has been opened (set `boardMounted`), then keep it mounted; toggle visibility with `display` so it isn't remounted (preserves drawing + correct sizing on first mount). On the Excalidraw `excalidrawAPI` callback, store the api; load the saved scene:

```tsx
const apiRef = useRef<any>(null);
const saveTimer = useRef<number | null>(null);

async function loadBoard(api: any) {
  apiRef.current = api;
  const raw = await loadTaskScene(task.id);
  if (!raw) return;
  try {
    const scene = JSON.parse(raw);
    const files = scene.files ?? {};
    if (Object.keys(files).length) api.addFiles(Object.values(files));
    api.updateScene({ elements: scene.elements ?? [] });
  } catch { /* corrupt/empty scene → start blank */ }
}

function scheduleSave() {
  if (saveTimer.current) clearTimeout(saveTimer.current);
  saveTimer.current = window.setTimeout(() => {
    const api = apiRef.current;
    if (!api) return;
    const json = serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local");
    void saveTaskScene(task.id, json);
  }, 800);
}
```

Render `<Excalidraw excalidrawAPI={loadBoard} onChange={scheduleSave} />` in a flex:1 container. On unmount/close, flush a final save (effect cleanup calling the serialize+save directly). The board container must have a concrete height (drawer is flex column; board area `flex:1, minHeight:0`).

- [ ] **Step 6:** Add a small `.cu-markdown` style block (in `App.css`) so rendered markdown looks tidy (headings, lists, code, links use `colors.accent`).

---

## Task H: `App.tsx` + `App.css` color refresh

**Files:** Modify `src/App.tsx`, `src/App.css`

- [ ] **Step 1:** Refresh `App.css`: update the toolbar accent from `#396cd8` to the indigo accent (`#6366f1`), give buttons the new radius/shadow, add a `.app-toolbar .primary` style (filled indigo, white text) and a `.cu-markdown` block. Keep scoping under `.app-toolbar` to avoid leaking into Excalidraw.
- [ ] **Step 2:** In `App.tsx`, add `className="primary"` to the Generate button; ensure the toolbar/banner use the refreshed palette (subtle surface bg, border from tokens). No logic changes.

---

## Task I: Verification

- [ ] **Step 1:** `npm test` → all vitest suites pass.
- [ ] **Step 2:** `cd src-tauri && cargo build` → success, no warnings.
- [ ] **Step 3:** `npm run build` → tsc + vite succeed.
- [ ] **Step 4 (manual, when user runs):** `npm run tauri dev`; enter token; verify groups, drawer detail + markdown + comments, "Open in ClickUp", and that a per-task board persists across reopen and across tasks.

---

## Task J: Code-review loop (autonomous, until clean)

Run repeatedly — **do not pause for confirmation between cycles** (user preference: autonomous refine loops):

- [ ] **Step 1:** Ensure `npm test`, `cargo build`, `npm run build` are green.
- [ ] **Step 2:** Run `/code-review` (high) over the diff.
- [ ] **Step 3:** Apply fixes for all confirmed/plausible findings; rebuild + retest.
- [ ] **Step 4:** Re-run `/code-review`. Repeat steps 2–3 until a pass returns no actionable findings (safety stop at 6 cycles; if not converged, report remaining items).
- [ ] **Step 5:** Report final review result + summary of changes.

---

## Self-review notes
- **Spec coverage:** collapsible status groups (Tasks E/F), slide-over drawer (G), markdown render (D/G), read-only comments (A/G), per-task drawing board (A/G), improved colors (D/H), code-review loop (J). ✓
- **Type consistency:** Rust `Task`/`Comment` (camelCase) ↔ TS `ClickUpTask`/`Comment` field-for-field; `normalize` shared by list + detail. ✓
- **No new capability/plugin:** `open_external` via `Command` (consistent with existing `claude` invocation). ✓
