use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::ipc::Channel;
use tauri::Manager;

/// System prompt that instructs Claude to emit our diagram JSON. Lives next to this file.
const SYSTEM_PROMPT: &str = include_str!("diagram_prompt.txt");

/// User home directory: HOME on Linux/macOS, USERPROFILE on Windows.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Candidate paths to the `claude` binary: PATH first, then the common user-install dir
/// (a packaged desktop app may not inherit the terminal's PATH).
fn claude_candidates() -> Vec<String> {
    let mut candidates = vec!["claude".to_string()];
    if let Some(home) = home_dir() {
        candidates.push(home.join(".local/bin/claude").to_string_lossy().into_owned());
        candidates.push(home.join(".claude/local/claude").to_string_lossy().into_owned());
    }
    candidates.push("/usr/local/bin/claude".to_string());
    candidates.push("/opt/homebrew/bin/claude".to_string());
    candidates
}

/// Run `claude -p <prompt> --append-system-prompt <system_prompt>` in headless mode and
/// return its raw JSON envelope (stdout).
/// NOTE: never pass `--bare` — it skips OAuth/keychain reads and would force an API key.
/// Plain `claude -p` uses the user's Max subscription login.
fn run_claude(system_prompt: &str, prompt: &str) -> Result<String, String> {
    let mut last_err = String::new();
    for bin in claude_candidates() {
        match Command::new(&bin)
            .arg("-p")
            .arg(prompt)
            .arg("--output-format")
            .arg("json")
            .arg("--append-system-prompt")
            .arg(system_prompt)
            .output()
        {
            Ok(output) if output.status.success() => {
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
            Ok(output) => {
                return Err(format!(
                    "claude exited with an error:\n{}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            Err(e) => last_err = format!("{bin}: {e}"),
        }
    }
    Err(format!(
        "Could not launch `claude` ({last_err}). Is it installed and on PATH? Did you run `claude login`?"
    ))
}

/// Generate a diagram: ask Claude (with the diagram system prompt) for shape JSON.
#[tauri::command]
async fn generate_diagram(prompt: String) -> Result<String, String> {
    run_claude(SYSTEM_PROMPT, &prompt)
}

/// Directory where scenes and exports are stored: ~/.ai-whiteboard (created if missing).
fn data_dir() -> Result<PathBuf, String> {
    let dir = home_dir()
        .ok_or("Could not determine your home directory")?
        .join(".ai-whiteboard");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Save the scene JSON to ~/.ai-whiteboard/scene.json; returns the path written.
#[tauri::command]
fn save_scene(json: String) -> Result<String, String> {
    let path = data_dir()?.join("scene.json");
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Load the previously saved scene JSON.
#[tauri::command]
fn load_scene() -> Result<String, String> {
    let path = data_dir()?.join("scene.json");
    std::fs::read_to_string(&path).map_err(|e| format!("No saved scene yet ({e})"))
}

/// Write PNG bytes to ~/.ai-whiteboard/export.png; returns the path written.
#[tauri::command]
fn save_png(bytes: Vec<u8>) -> Result<String, String> {
    let path = data_dir()?.join("export.png");
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// ClickUp integration: list the tasks assigned to the authenticated user.
// ---------------------------------------------------------------------------

/// Persisted app config (~/.ai-whiteboard/config.json). The on-disk key is
/// `clickupToken` to match the camelCase the settings UI sends.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct AppConfig {
    #[serde(rename = "clickupToken", default)]
    clickup_token: Option<String>,
}

// --- ClickUp API response shapes (only the fields we read) ---

#[derive(serde::Deserialize)]
struct UserResponse {
    user: ClickUpUser,
}
#[derive(serde::Deserialize)]
struct ClickUpUser {
    id: i64,
}

#[derive(serde::Deserialize)]
struct TeamsResponse {
    teams: Vec<Team>,
}
#[derive(serde::Deserialize)]
struct Team {
    id: String,
}

#[derive(serde::Deserialize)]
struct TasksResponse {
    tasks: Vec<RawTask>,
    #[serde(default)]
    last_page: bool,
}
/// ClickUp occasionally sends numeric fields as strings; accept either.
fn de_opt_i64<'de, D>(d: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    Ok(Option::<serde_json::Value>::deserialize(d)?.and_then(|v| match v {
        // ClickUp sometimes encodes orderindex as a float or a decimal string.
        serde_json::Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        serde_json::Value::String(s) => {
            s.parse::<i64>().ok().or_else(|| s.parse::<f64>().ok().map(|f| f as i64))
        }
        _ => None,
    }))
}

#[derive(serde::Deserialize)]
struct RawTask {
    id: String,
    name: String,
    status: Option<RawStatus>,
    #[serde(default)]
    due_date: Option<String>, // ms-epoch string, or null
    #[serde(default)]
    start_date: Option<String>,
    #[serde(default)]
    url: Option<String>,
    list: Option<RawList>,
    priority: Option<RawPriority>,
    #[serde(default)]
    assignees: Vec<RawAssignee>,
    #[serde(default)]
    tags: Vec<RawTag>,
    #[serde(default)]
    markdown_description: Option<String>, // present only on the single-task endpoint
    #[serde(default)]
    text_content: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawStatus {
    status: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(rename = "type", default)]
    kind: Option<String>, // "open" | "custom" | "done" | "closed"
    #[serde(default, deserialize_with = "de_opt_i64")]
    orderindex: Option<i64>,
}
#[derive(serde::Deserialize)]
struct RawPriority {
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    color: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawAssignee {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    initials: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawTag {
    name: String,
    #[serde(default)]
    tag_fg: Option<String>,
    #[serde(default)]
    tag_bg: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawList {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// Normalized task handed to the frontend (camelCase for idiomatic TS).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Assignee {
    username: String,
    color: Option<String>,
    initials: Option<String>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Tag {
    name: String,
    fg: Option<String>,
    bg: Option<String>,
}
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
    list_id: Option<String>,
    list_name: Option<String>,
    priority: Option<String>,
    priority_color: Option<String>,
    assignees: Vec<Assignee>,
    tags: Vec<Tag>,
    markdown_description: Option<String>,
    text_description: Option<String>,
}

/// Shape a raw ClickUp task (from either the list or single-task endpoint) into a `Task`.
fn normalize(t: RawTask) -> Task {
    let (status, status_color, status_type, status_orderindex) = match t.status {
        Some(s) => (s.status, s.color, s.kind, s.orderindex),
        None => (String::new(), None, None, None),
    };
    let (priority, priority_color) = match t.priority {
        Some(p) => (p.priority, p.color),
        None => (None, None),
    };
    let (list_id, list_name) = match t.list {
        Some(l) => (l.id, l.name),
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
        list_id,
        list_name,
        priority,
        priority_color,
        assignees: t
            .assignees
            .into_iter()
            .map(|a| Assignee {
                username: a.username.unwrap_or_default(),
                color: a.color,
                initials: a.initials,
            })
            .collect(),
        tags: t
            .tags
            .into_iter()
            .map(|t| Tag {
                name: t.name,
                fg: t.tag_fg,
                bg: t.tag_bg,
            })
            .collect(),
        markdown_description: t.markdown_description,
        text_description: t.text_content,
    }
}

/// Read the saved ClickUp token; a missing file or blank token yields `None`.
fn read_token() -> Result<Option<String>, String> {
    let path = data_dir()?.join("config.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            let cfg: AppConfig = serde_json::from_str(&s).map_err(|e| e.to_string())?;
            Ok(cfg.clickup_token.filter(|t| !t.trim().is_empty()))
        }
        Err(_) => Ok(None), // no config yet is not an error
    }
}

/// Persist the ClickUp personal token to ~/.ai-whiteboard/config.json.
#[tauri::command]
fn save_clickup_token(token: String) -> Result<(), String> {
    let path = data_dir()?.join("config.json");
    let cfg = AppConfig {
        clickup_token: Some(token.trim().to_string()),
    };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Return the saved token (empty string when unset) to prefill the settings field.
#[tauri::command]
fn load_clickup_token() -> Result<String, String> {
    Ok(read_token()?.unwrap_or_default())
}

/// Friendly message for a transport-level (connection/DNS/TLS) failure.
fn net_err(e: reqwest::Error) -> String {
    format!("Network error contacting ClickUp: {e}")
}

/// Map a non-success HTTP status to a friendly error; 401 is called out specially
/// so a bad token reads clearly no matter which endpoint returns it.
fn check_status(resp: reqwest::Response, what: &str) -> Result<reqwest::Response, String> {
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(
            "ClickUp rejected the token (401). Check your personal token in Settings.".into(),
        );
    }
    if !resp.status().is_success() {
        return Err(format!("ClickUp {what} error {}", resp.status()));
    }
    Ok(resp)
}

/// Fetch every open task assigned to the authenticated user, across all workspaces.
#[tauri::command]
async fn fetch_my_clickup_tasks() -> Result<Vec<Task>, String> {
    let token = read_token()?.ok_or("No ClickUp token saved. Add one in Settings.")?;

    let client = reqwest::Client::new();
    let auth = |rb: reqwest::RequestBuilder| rb.header("Authorization", &token);

    // 1) Who am I?
    let user_id = authed_get::<UserResponse>("https://api.clickup.com/api/v2/user", "/user")
        .await?
        .user
        .id;

    // 2) Which workspaces?
    let teams = authed_get::<TeamsResponse>("https://api.clickup.com/api/v2/team", "/team")
        .await?
        .teams;

    // 3) Paginated tasks assigned to me in each workspace.
    let mut out: Vec<Task> = Vec::new();
    for team in teams {
        let url = format!("https://api.clickup.com/api/v2/team/{}/task", team.id);
        let mut page = 0;
        loop {
            let resp = check_status(
                auth(client.get(&url).query(&[
                    ("assignees[]", user_id.to_string()),
                    ("include_closed", "false".to_string()),
                    ("page", page.to_string()),
                ]))
                .send()
                .await
                .map_err(net_err)?,
                "tasks",
            )?;
            let body = resp
                .json::<TasksResponse>()
                .await
                .map_err(|e| e.to_string())?;
            let empty = body.tasks.is_empty();
            for t in body.tasks {
                out.push(normalize(t));
            }
            // Stop on the API's last-page flag, an empty page, or a hard cap (loop guard).
            if body.last_page || empty || page >= 50 {
                break;
            }
            page += 1;
        }
    }
    Ok(out)
}

/// GET a ClickUp endpoint with the saved token and deserialize the JSON body.
async fn authed_get<T: serde::de::DeserializeOwned>(url: &str, what: &str) -> Result<T, String> {
    let token = read_token()?.ok_or("No ClickUp token saved. Add one in Settings.")?;
    let resp = check_status(
        reqwest::Client::new()
            .get(url)
            .header("Authorization", token)
            .send()
            .await
            .map_err(net_err)?,
        what,
    )?;
    resp.json::<T>().await.map_err(|e| e.to_string())
}

/// Fetch a single task with its full (markdown) description.
#[tauri::command]
async fn fetch_clickup_task(task_id: String) -> Result<Task, String> {
    let url =
        format!("https://api.clickup.com/api/v2/task/{task_id}?include_markdown_description=true");
    let raw: RawTask = authed_get(&url, "task").await?;
    Ok(normalize(raw))
}

#[derive(serde::Deserialize)]
struct CommentsResponse {
    comments: Vec<RawComment>,
}
#[derive(serde::Deserialize)]
struct RawComment {
    id: String,
    #[serde(default)]
    comment_text: Option<String>,
    user: Option<RawCommentUser>,
    #[serde(default)]
    date: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawCommentUser {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    initials: Option<String>,
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

/// Fetch a task's comments (read-only).
#[tauri::command]
async fn fetch_clickup_comments(task_id: String) -> Result<Vec<Comment>, String> {
    let url = format!("https://api.clickup.com/api/v2/task/{task_id}/comment");
    let body: CommentsResponse = authed_get(&url, "comments").await?;
    Ok(body
        .comments
        .into_iter()
        .map(|c| {
            let (author, author_color, author_initials) = match c.user {
                Some(u) => (u.username.unwrap_or_default(), u.color, u.initials),
                None => (String::new(), None, None),
            };
            Comment {
                id: c.id,
                text: c.comment_text.unwrap_or_default(),
                author,
                author_color,
                author_initials,
                date: c.date,
            }
        })
        .collect())
}

// --- ClickUp writes. The saved pk_ token is full read+write; these only run on an
//     explicit user action in the UI (e.g. picking a status), never automatically. ---

/// Send a POST/PUT to ClickUp with the saved token. On a non-success status, include the
/// response body so ClickUp's own message (e.g. an invalid status name) reaches the user.
async fn authed_send<B: serde::Serialize>(
    method: reqwest::Method,
    url: &str,
    body: &B,
    what: &str,
) -> Result<serde_json::Value, String> {
    let token = read_token()?.ok_or("No ClickUp token saved. Add one in Settings.")?;
    let resp = reqwest::Client::new()
        .request(method, url)
        .header("Authorization", token)
        .json(body)
        .send()
        .await
        .map_err(net_err)?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("ClickUp rejected the token (401). Check your personal token in Settings.".into());
    }
    if !resp.status().is_success() {
        let code = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("ClickUp {what} error {code}: {detail}"));
    }
    Ok(resp
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null))
}

/// Add a comment to a task.
#[tauri::command]
async fn clickup_add_comment(task_id: String, text: String) -> Result<(), String> {
    let url = format!("https://api.clickup.com/api/v2/task/{task_id}/comment");
    authed_send(
        reqwest::Method::POST,
        &url,
        &serde_json::json!({ "comment_text": text, "notify_all": false }),
        "comment",
    )
    .await?;
    Ok(())
}

/// Change a task's status (must be a status that exists in the task's list).
#[tauri::command]
async fn clickup_set_status(task_id: String, status: String) -> Result<(), String> {
    let url = format!("https://api.clickup.com/api/v2/task/{task_id}");
    authed_send(
        reqwest::Method::PUT,
        &url,
        &serde_json::json!({ "status": status }),
        "status update",
    )
    .await?;
    Ok(())
}

/// Set a task's priority (1=urgent, 2=high, 3=normal, 4=low).
#[tauri::command]
async fn clickup_set_priority(task_id: String, priority: i64) -> Result<(), String> {
    let url = format!("https://api.clickup.com/api/v2/task/{task_id}");
    authed_send(
        reqwest::Method::PUT,
        &url,
        &serde_json::json!({ "priority": priority }),
        "priority update",
    )
    .await?;
    Ok(())
}

/// Set a task's due date (ms-epoch).
#[tauri::command]
async fn clickup_set_due_date(task_id: String, due_date: i64) -> Result<(), String> {
    let url = format!("https://api.clickup.com/api/v2/task/{task_id}");
    authed_send(
        reqwest::Method::PUT,
        &url,
        &serde_json::json!({ "due_date": due_date, "due_date_time": false }),
        "due date update",
    )
    .await?;
    Ok(())
}

/// Create a subtask under `parent_id` in `list_id`; returns the new task id.
#[tauri::command]
async fn clickup_create_subtask(
    list_id: String,
    parent_id: String,
    name: String,
    description: Option<String>,
) -> Result<String, String> {
    let url = format!("https://api.clickup.com/api/v2/list/{list_id}/task");
    let mut body = serde_json::json!({ "name": name, "parent": parent_id });
    if let Some(d) = description.filter(|s| !s.trim().is_empty()) {
        body["markdown_content"] = serde_json::Value::String(d);
    }
    let v = authed_send(reqwest::Method::POST, &url, &body, "subtask create").await?;
    match v.get("id").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
        Some(id) => Ok(id.to_string()),
        None => Err("ClickUp created the subtask but returned no id.".into()),
    }
}

#[derive(serde::Deserialize)]
struct ListResponse {
    #[serde(default)]
    statuses: Vec<RawListStatus>,
}
#[derive(serde::Deserialize)]
struct RawListStatus {
    status: String,
}

/// The status names available in a list, so the status picker can offer valid statuses.
#[tauri::command]
async fn fetch_list_statuses(list_id: String) -> Result<Vec<String>, String> {
    let url = format!("https://api.clickup.com/api/v2/list/{list_id}");
    let body: ListResponse = authed_get(&url, "list").await?;
    Ok(body.statuses.into_iter().map(|s| s.status).collect())
}

/// Open an http(s) URL in the user's default browser.
#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Refusing to open a non-http URL".into());
    }
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    let mut child = Command::new(program)
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    // Reap the short-lived opener process so it doesn't linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Path of a task's saved drawing board, validating the id to prevent path traversal.
fn task_scene_path(task_id: &str) -> Result<PathBuf, String> {
    if task_id.is_empty()
        || !task_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid task id".into());
    }
    let dir = data_dir()?.join("tasks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{task_id}.json")))
}

/// Save a task's Excalidraw scene to ~/.ai-whiteboard/tasks/{task_id}.json.
#[tauri::command]
fn save_task_scene(task_id: String, json: String) -> Result<(), String> {
    std::fs::write(task_scene_path(&task_id)?, json).map_err(|e| e.to_string())
}

/// Load a task's saved scene; an empty string means "no board yet".
#[tauri::command]
fn load_task_scene(task_id: String) -> Result<String, String> {
    match std::fs::read_to_string(task_scene_path(&task_id)?) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

// ---------------------------------------------------------------------------
// Agentic Claude Code sessions: stream `claude -p --output-format stream-json`
// to the frontend over an IPC Channel, with cancellation + session persistence.
// ---------------------------------------------------------------------------

/// One framed line (or lifecycle signal) from a running `claude` process.
/// The frontend parses the stream-json schema from `Stdout` lines.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum AgentEvent {
    Stdout { line: String },
    Stderr { line: String },
    Done {
        exit_code: Option<i32>,
        session_id: Option<String>,
    },
}

/// Live `claude` child processes, keyed by the caller's run id, so they can be cancelled.
#[derive(Default)]
struct RunRegistry(Mutex<HashMap<String, Child>>);

/// Translate a UI permission level into `claude` permission flags. The CLI's
/// `--permission-mode` accepts: default, plan, acceptEdits, auto, dontAsk, bypassPermissions.
fn permission_args(mode: &str) -> Vec<String> {
    match mode {
        // Read-only: deny all writes AND shell (dontAsk alone is NOT a deny mode), and
        // pre-allow read/search tools so they don't abort. Bash is blocked entirely since it
        // can mutate — by design a read-only chat can't run shell commands.
        "read" => vec![
            "--permission-mode".into(),
            "dontAsk".into(),
            "--allowedTools".into(),
            "Read,Grep,Glob,LS,WebFetch,WebSearch".into(),
            "--disallowedTools".into(),
            "Write,Edit,MultiEdit,NotebookEdit,Bash".into(),
        ],
        "auto" => vec!["--permission-mode".into(), "auto".into()],
        "full" => vec!["--permission-mode".into(), "bypassPermissions".into()],
        // Auto-accept edits + common filesystem commands (the default).
        "acceptEdits" => vec!["--permission-mode".into(), "acceptEdits".into()],
        _ => vec!["--permission-mode".into(), "acceptEdits".into()],
    }
}

/// Cheap scan of a stream-json line for a `session_id` (present on `system/init` and `result`).
fn session_id_of(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    v.get("session_id")?.as_str().map(|s| s.to_string())
}

/// Run `claude -p` agentically in `cwd`, streaming each stdout/stderr line to `on_event`.
/// Returns immediately; the process is read + reaped on a worker thread. NEVER passes
/// `--bare` (that would force an API key) — plain `-p` uses the user's Max login.
#[tauri::command]
async fn claude_run(
    app: tauri::AppHandle,
    on_event: Channel<AgentEvent>,
    run_id: String,
    prompt: String,
    cwd: String,
    permission_mode: String,
    resume: Option<String>,
    append_system_prompt: Option<String>,
    add_dirs: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    if run_id.is_empty()
        || !run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid run id".into());
    }
    if cwd.trim().is_empty() {
        return Err("Pick a working folder first.".into());
    }
    let cwd_path = match std::fs::canonicalize(&cwd) {
        Ok(p) if p.is_dir() => p,
        _ => return Err(format!("Working folder does not exist: {cwd}")),
    };

    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt,
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
    ];
    args.extend(permission_args(&permission_mode));
    if let Some(sid) = resume.filter(|s| !s.trim().is_empty()) {
        args.push("--resume".into());
        args.push(sid);
    }
    if let Some(ctx) = append_system_prompt.filter(|s| !s.trim().is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(ctx);
    }
    for dir in add_dirs.unwrap_or_default() {
        if !dir.trim().is_empty() {
            args.push("--add-dir".into());
            args.push(dir);
        }
    }
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        args.push("--model".into());
        args.push(m);
    }
    if let Some(e) = effort.filter(|s| !s.trim().is_empty()) {
        args.push("--effort".into()); // native CLI flag: low | medium | high | xhigh | max
        args.push(e);
    }

    // Spawn the first `claude` candidate that launches. Give it its own process group so
    // cancellation can kill the whole tree (claude + its Bash/sub-agent subprocesses).
    let mut spawned: Option<Child> = None;
    let mut last_err = String::new();
    for bin in claude_candidates() {
        let mut cmd = Command::new(&bin);
        cmd.args(&args)
            .current_dir(&cwd_path)
            .stdin(Stdio::null()) // no tty → a would-be permission prompt fails fast, never hangs
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        match cmd.spawn() {
            Ok(child) => {
                spawned = Some(child);
                break;
            }
            Err(e) => last_err = format!("{bin}: {e}"),
        }
    }
    let mut child = spawned.ok_or_else(|| {
        format!("Could not launch `claude` ({last_err}). Is it installed and on PATH? Did you run `claude login`?")
    })?;

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("claude produced no stdout".into());
        }
    };
    let stderr = child.stderr.take();
    {
        let reg = app.state::<RunRegistry>();
        let mut map = reg.0.lock().map_err(|_| "run registry is poisoned".to_string())?;
        map.insert(run_id.clone(), child);
    }

    // stderr reader (best-effort diagnostics).
    if let Some(stderr) = stderr {
        let ch = on_event.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = ch.send(AgentEvent::Stderr { line });
            }
        });
    }

    // stdout reader: stream lines, then reap the child and emit Done.
    std::thread::spawn(move || {
        let mut session_id: Option<String> = None;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if session_id.is_none() {
                if let Some(sid) = session_id_of(&line) {
                    session_id = Some(sid);
                }
            }
            let _ = on_event.send(AgentEvent::Stdout { line });
        }
        // stdout closed → the process is exiting (or was killed). Reap it if it's still ours.
        let reg = app.state::<RunRegistry>();
        let child_opt = reg.0.lock().ok().and_then(|mut m| m.remove(&run_id));
        let exit_code = child_opt
            .and_then(|mut c| c.wait().ok())
            .and_then(|s| s.code());
        let _ = on_event.send(AgentEvent::Done { exit_code, session_id });
    });

    Ok(())
}

/// Kill a running agent session (closes its pipes → the reader thread emits Done).
#[tauri::command]
fn claude_cancel(registry: tauri::State<'_, RunRegistry>, run_id: String) -> Result<(), String> {
    let child = registry
        .0
        .lock()
        .map_err(|_| "run registry is poisoned".to_string())?
        .remove(&run_id);
    if let Some(mut c) = child {
        // Kill the whole process group (claude + its tool subprocesses); pgid == child pid.
        #[cfg(unix)]
        {
            let pid = c.id() as i32;
            let _ = Command::new("kill")
                .arg("-KILL")
                .arg(format!("-{pid}"))
                .status();
        }
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(())
}

/// Path of a saved agent session, validating the key to prevent path traversal.
fn agent_session_path(key: &str) -> Result<PathBuf, String> {
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid session key".into());
    }
    let dir = data_dir()?.join("agent");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{key}.json")))
}

/// Persist an agent session (transcript + session id) to ~/.ai-whiteboard/agent/{key}.json.
#[tauri::command]
fn save_agent_session(key: String, json: String) -> Result<(), String> {
    std::fs::write(agent_session_path(&key)?, json).map_err(|e| e.to_string())
}

/// Load a saved agent session; an empty string means "none yet".
#[tauri::command]
fn load_agent_session(key: String) -> Result<String, String> {
    match std::fs::read_to_string(agent_session_path(&key)?) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

/// Delete a saved agent session (the user's "Clear" control).
#[tauri::command]
fn delete_agent_session(key: String) -> Result<(), String> {
    let path = agent_session_path(&key)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A discovered custom slash command (from .claude/commands markdown files).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SlashCommand {
    name: String, // without the leading slash; subdirs namespace as "dir:cmd"
    description: String,
    source: String, // "project" | "user"
}

/// Pull a one-line description from a command file: frontmatter `description:` or first text line.
fn command_description(path: &std::path::Path) -> String {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        for line in trimmed.lines().skip(1) {
            let l = line.trim();
            if l == "---" {
                break;
            }
            if let Some(rest) = l.strip_prefix("description:") {
                return rest.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            }
        }
    }
    for line in content.lines() {
        let t = line.trim().trim_start_matches('#').trim();
        if !t.is_empty() && t != "---" {
            return t.chars().take(120).collect();
        }
    }
    String::new()
}

/// Recursively collect *.md commands under `dir`, namespacing subdirs as "sub:cmd".
/// `depth` caps recursion so a symlink cycle can't overflow the stack / walk the whole disk.
fn collect_commands(
    dir: &std::path::Path,
    prefix: &str,
    source: &str,
    depth: u8,
    out: &mut Vec<SlashCommand>,
) {
    if depth >= 6 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // missing dir is not an error
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Don't follow directory symlinks (avoids cycles / escaping the commands tree).
        if path.is_dir() && !entry.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                collect_commands(&path, &format!("{prefix}{name}:"), source, depth + 1, out);
            }
        } else if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            if let Some(stem) = path.file_stem().and_then(|n| n.to_str()) {
                out.push(SlashCommand {
                    name: format!("{prefix}{stem}"),
                    description: command_description(&path),
                    source: source.to_string(),
                });
            }
        }
    }
}

/// List custom slash commands from the project (`<cwd>/.claude/commands`) and home
/// (`~/.claude/commands`) directories — the same places the Claude CLI reads them.
#[tauri::command]
fn list_slash_commands(cwd: String) -> Vec<SlashCommand> {
    let mut out = Vec::new();
    if !cwd.trim().is_empty() {
        collect_commands(
            &PathBuf::from(cwd.trim()).join(".claude/commands"),
            "",
            "project",
            0,
            &mut out,
        );
    }
    if let Some(home) = home_dir() {
        collect_commands(&home.join(".claude/commands"), "", "user", 0, &mut out);
    }
    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RunRegistry::default())
        .invoke_handler(tauri::generate_handler![
            generate_diagram,
            save_scene,
            load_scene,
            save_png,
            save_clickup_token,
            load_clickup_token,
            fetch_my_clickup_tasks,
            fetch_clickup_task,
            fetch_clickup_comments,
            fetch_list_statuses,
            clickup_add_comment,
            clickup_set_status,
            clickup_set_priority,
            clickup_set_due_date,
            clickup_create_subtask,
            open_external,
            save_task_scene,
            load_task_scene,
            claude_run,
            claude_cancel,
            save_agent_session,
            load_agent_session,
            delete_agent_session,
            list_slash_commands
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
