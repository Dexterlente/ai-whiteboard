use std::path::PathBuf;
use std::process::Command;

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
    }
    candidates
}

/// Run `claude -p <prompt>` in headless mode and return its raw JSON envelope (stdout).
/// NOTE: never pass `--bare` — it skips OAuth/keychain reads and would force an API key.
/// Plain `claude -p` uses the user's Max subscription login.
#[tauri::command]
async fn generate_diagram(prompt: String) -> Result<String, String> {
    let mut last_err = String::new();
    for bin in claude_candidates() {
        match Command::new(&bin)
            .arg("-p")
            .arg(&prompt)
            .arg("--output-format")
            .arg("json")
            .arg("--append-system-prompt")
            .arg(SYSTEM_PROMPT)
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
#[derive(serde::Deserialize)]
struct RawTask {
    id: String,
    name: String,
    status: Option<RawStatus>,
    #[serde(default)]
    due_date: Option<String>, // ms-epoch string, or null
    #[serde(default)]
    url: Option<String>,
    list: Option<RawList>,
}
#[derive(serde::Deserialize)]
struct RawStatus {
    status: String,
    #[serde(default)]
    color: Option<String>,
}
#[derive(serde::Deserialize)]
struct RawList {
    #[serde(default)]
    name: Option<String>,
}

/// Normalized task handed to the frontend (camelCase for idiomatic TS).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    name: String,
    status: String,
    status_color: Option<String>,
    due_date: Option<String>,
    url: Option<String>,
    list_name: Option<String>,
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
    let user_resp = check_status(
        auth(client.get("https://api.clickup.com/api/v2/user"))
            .send()
            .await
            .map_err(net_err)?,
        "/user",
    )?;
    let user_id = user_resp
        .json::<UserResponse>()
        .await
        .map_err(|e| e.to_string())?
        .user
        .id;

    // 2) Which workspaces?
    let teams = check_status(
        auth(client.get("https://api.clickup.com/api/v2/team"))
            .send()
            .await
            .map_err(net_err)?,
        "/team",
    )?
    .json::<TeamsResponse>()
    .await
    .map_err(|e| e.to_string())?
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
                let (status, status_color) =
                    t.status.map(|s| (s.status, s.color)).unwrap_or_default();
                out.push(Task {
                    id: t.id,
                    name: t.name,
                    status,
                    status_color,
                    due_date: t.due_date,
                    url: t.url,
                    list_name: t.list.and_then(|l| l.name),
                });
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            generate_diagram,
            save_scene,
            load_scene,
            save_png,
            save_clickup_token,
            load_clickup_token,
            fetch_my_clickup_tasks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
