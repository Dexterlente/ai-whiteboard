# Dexter Managing Software

A local **Tauri desktop app** that puts your ClickUp work and an embedded **Claude Code** agent in one window. Browse and manage the tickets assigned to you, sketch each one out on its own whiteboard, drop tasks onto a freeform board, and let an AI agent work directly in your project folder.

Everything runs on your machine. ClickUp is reached over its REST API with a token you enter in‑app; the AI features shell out to your **local `claude` CLI** using your existing Claude login — **no API key is stored or required**.

---

## Table of contents

- [Overview](#overview)
- [Quick install](#quick-install-build-from-source)
- [Feature guide](#feature-guide)
- [Usage walkthrough](#usage-walkthrough)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Backend commands](#backend-commands-tauri)
- [Project structure](#project-structure)
- [Data & privacy](#data--privacy)
- [Prerequisites](#prerequisites)
- [Develop, test, build](#develop-test-build)
- [Install the app](#install-the-app)
- [Troubleshooting](#troubleshooting)
- [Notes & limitations](#notes--limitations)

---

## Overview

The window is split in two:

- **Left — ClickUp task sidebar:** the tickets assigned to you, grouped by status.
- **Right — workspace:** toggles between the **Claude Code** agent and the **task board** via the tab above the list.

Opening a ticket slides in a **detail drawer** over the right side. The app is offline‑first: your token, drawings, and agent sessions live in `~/.ai-whiteboard/` and never leave your machine except for calls to ClickUp's API and your local `claude`.

---

## Quick install (build from source)

> Linux (Ubuntu/Debian). Builds and installs the desktop app.

```bash
# 1 — Get the code
git clone https://github.com/Dexterlente/ai-whiteboard.git
cd ai-whiteboard

# 2 — System dependencies (one-time)
sudo apt update
sudo apt install nodejs npm build-essential curl libwebkit2gtk-4.1-dev \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
# Rust (if you don't have it): https://rustup.rs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 3 — Build the installable package (.deb)
npm install
npm run tauri build -- --bundles deb

# 4 — Install it
sudo dpkg -i "src-tauri/target/release/bundle/deb/Dexter Managing Software_0.1.0_amd64.deb"
sudo apt -f install        # only if dpkg reports missing dependencies

# 5 — Launch
# search "Dexter Managing Software" in the GNOME app grid, or run:  todo
```

**Before first use:** install and sign in to the `claude` CLI (`claude login`) for the AI features, and on first launch open the ⚙ settings to paste your ClickUp `pk_…` token.

To **update** later: `git pull`, rebuild step 3, reinstall step 4. To **uninstall**: `sudo apt remove dexter-managing-software`. For the portable **AppImage** instead of a `.deb`, and the full nuances, see [Install the app](#install-the-app).

---

## Feature guide

### ClickUp tasks (left sidebar)
- Connect with a ClickUp **personal token** (`pk_…`) via the ⚙ settings.
- Lists the tasks **assigned to you across all your workspaces**, fetched paginated.
- **Grouped by status**, with **In Progress pinned to the top**; groups are collapsible (only In Progress is open on launch).
- Each row: title, a colored status, priority flag, relative due date (red when overdue), assignee avatars, and tag chips.
- Refresh (↻) re‑fetches; tasks can be **dragged onto the board**.

### Task detail drawer
Opens when you click a task:
- **Rendered markdown** description (sanitized with DOMPurify) and **read‑only comments** with author + relative time.
- Metadata: status badge, priority, due/start dates, assignees, tags, list name.
- **Change status from the badge** — click it, pick a status from the list's real statuses; it writes back to ClickUp and the sidebar re‑groups live.
- **Open in ClickUp** opens the ticket in your system browser.
- **Split view** toggle — details on the left, the work pane (board/assistant) on the right.
- Tabs: **Details · 🖉 Board · ✨ Ask Claude**.
- **Per‑task Excalidraw board** — a drawing canvas saved per ticket, with an AI **"Generate diagram"** prompt that draws shapes onto *that* task's board and an **Export PNG**.
- **Image lightbox** (click a description image to zoom) and smooth slide‑in/out animation.

### Task board (whiteboard)
A local, freeform board of task cards (toggle the **▦ Board** tab above the list):
- **Add cards** three ways: **+ Add task** (searchable picker of your tasks), **paste a ClickUp link/id**, or **drag a task from the sidebar**.
- **Drag** cards to arrange them on a dotted canvas; **click** a card to open the ticket; **✕** removes it **from the board only** (never deletes the ClickUp ticket).
- Card positions and contents **persist locally** (browser `localStorage`), so your layout survives restarts.

### Claude Code agent
A real Claude Code session embedded in the app — two places:
- **Standalone panel** (the Claude Code tab) for working in any folder.
- **Per‑ticket assistant** (a ticket's Ask Claude tab) that receives the ticket as context.

Capabilities:
- **Streaming** assistant output and live **tool activity** (expandable).
- **Work folder** picker (native dialog) — the agent runs there.
- **Model** (Opus / Sonnet / Haiku / Fable), **effort** (low → max), and **permission** (read‑only / auto‑edits / auto / full) selectors. **Shift+Tab** cycles the permission mode like the CLI.
- **Slash‑command autocomplete** — type `/` to get built‑ins (`/code-review`, `/review`, `/init`, `/model`, `/effort`, `/compact`, …) plus your **custom commands** discovered from `.claude/commands/` (project + `~/.claude/commands/`).
- Sessions **persist and resume** across turns; **Stop** cancels a run (kills the whole process group); **Clear** wipes a conversation.

### Look & feel
Inter typeface (bundled), solid white‑on‑color status/tag badges that auto‑darken so the label stays legible, a custom app icon, and consistent spacing.

---

## Usage walkthrough

1. **Launch** the app (`npm run tauri dev`, or the installed app from your dock).
2. **Connect ClickUp:** click ⚙ in the task sidebar, paste your `pk_…` token, **Save & Refresh**. (Get a token from ClickUp → Settings → Apps → API Token.) Your assigned tasks appear, In Progress first.
3. **Work a ticket:** click it → read the description/comments, change its **status from the badge**, or hit **Split view** to draw and read side by side. Use the **Board** tab to sketch, or **Ask Claude** to have the agent work on it.
4. **Use the board:** switch the right pane to **▦ Board**, then add cards (pick / paste / drag) and arrange them. Click any card to reopen the full ticket.
5. **Use Claude Code:** switch to the **Claude Code** tab, pick a **work folder** (Open…), choose model/effort/permission (or **Shift+Tab** to cycle permission), and chat. Type `/` for commands.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| **Shift+Tab** | Cycle the Claude Code permission mode |
| **/** (in chat) | Open the slash‑command menu — ↑/↓ navigate, Tab/Enter insert, Esc dismiss |
| **Enter** / **Shift+Enter** | Send / newline in the chat |
| **Esc** | Close the ticket drawer (Details tab) or the slash menu / status dropdown |

---

## Architecture

- **Frontend** — React 19 + TypeScript, built with Vite. UI state is local React; the pure logic (status grouping, relative dates, badge colors, slash‑command parsing, and the agent‑stream reducer) lives in `src/lib/` and is covered by **vitest**.
- **Backend** — Rust (Tauri v2). ClickUp REST calls go through **`reqwest`** (rustls TLS). The AI features **spawn your local `claude` CLI**; the agent runs `claude -p --output-format stream-json` and streams each line back to the UI over a **Tauri IPC `Channel`**, on a worker thread, with cancellation via process‑group kill. The native folder picker uses **`tauri-plugin-dialog`**.
- **No API key** — `claude` runs as you, using your Max/Pro login. The app never stores or sends a model API key.
- **Storage** — small JSON/PNG files under `~/.ai-whiteboard/` (see [Data & privacy](#data--privacy)).

Data flow for the agent: UI (`AgentChat`) → `useAgentSession` hook → `runAgent()` → Tauri `claude_run` (spawns `claude`, reads stdout on a thread) → `AgentEvent` over the Channel → reducer (`applyEvent`) → rendered transcript.

---

## Backend commands (Tauri)

All in `src-tauri/src/lib.rs`, grouped:

| Group | Commands |
|---|---|
| ClickUp read | `fetch_my_clickup_tasks`, `fetch_clickup_task`, `fetch_clickup_comments`, `fetch_list_statuses` |
| ClickUp write | `clickup_set_status`, `clickup_set_priority`, `clickup_set_due_date`, `clickup_add_comment`, `clickup_create_subtask` |
| Token/config | `save_clickup_token`, `load_clickup_token` |
| AI (one‑shot) | `generate_diagram`, `claude_ask`, `claude_status`, `claude_test_connection` |
| AI agent (stream) | `claude_run`, `claude_cancel`, `save_agent_session`, `load_agent_session`, `delete_agent_session`, `list_slash_commands` |
| Scenes / misc | `save_task_scene`, `load_task_scene`, `save_scene`, `load_scene`, `save_png`, `open_external` |

---

## Project structure

```
src/
  App.tsx                  # layout: task sidebar (left) + Claude Code / Board (right)
  main.tsx                 # entry; loads Inter
  App.css                  # global styles (.primary, .cu-markdown, fonts)
  components/
    TaskPanel.tsx          # ClickUp task list + status tabs + settings
    TaskRow.tsx            # one task row (draggable)
    StatusGroup.tsx        # collapsible status section
    Avatar.tsx             # colored initials avatar
    TaskDrawer.tsx         # ticket detail: markdown, comments, status, board, Ask Claude
    TaskBoard.tsx          # freeform local board of task cards
    AgentPanel.tsx         # standalone Claude Code session (folder/model/effort/permission)
    AgentChat.tsx          # streaming chat + slash-command menu
    AssistantTab.tsx       # in-ticket "actions" assistant
    ui.ts                  # design tokens + color helpers (badges, contrast)
  hooks/
    useAgentSession.ts     # drives one streaming agent session
  lib/
    clickup.ts             # ClickUp invoke wrappers + types
    agent.ts               # agent types, runAgent, slash commands, stream reducer
    assistant.ts           # ticket-context builder for the assistant
    format.ts              # grouping, relative dates, initials
    markdown.ts            # marked + DOMPurify + external-link handling
    claude.ts, errors.ts, json.ts
    *.test.ts              # vitest suites
src-tauri/
  src/lib.rs               # all Tauri commands (see table above)
  tauri.conf.json          # productName, window, bundle targets (deb, appimage)
  capabilities/default.json# core + dialog permissions
  icons/                   # app icons (generated from public/app-icon.png)
```

---

## Data & privacy

Everything is local, under `~/.ai-whiteboard/`:

| Path | Contents |
|---|---|
| `config.json` | your ClickUp token (`{"clickupToken":"pk_…"}`) |
| `tasks/<taskId>.json` | each ticket's saved Excalidraw board |
| `agent/<key>.json` | saved agent conversations (panel + per‑ticket) |
| `scene.json`, `export.png` | legacy/global scene + PNG export |

The task **board layout** (which cards, where) is in the webview's `localStorage`. Nothing is committed to the repo or sent anywhere except ClickUp's API and your local `claude`.

---

## Prerequisites

- **Node.js** 18+ and npm
- **Rust** (stable) + Cargo
- The **`claude` CLI** installed and logged in (`claude login`) — required for AI features
- Linux build/runtime deps (Ubuntu/Debian):
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev
  ```
  > `librsvg2-dev` is only needed for the **AppImage** bundle; the `.deb` builds without it.

---

## Develop, test, build

```bash
npm install

npm run tauri dev                      # run with hot reload (dev)
npm test                               # vitest — pure-logic unit tests
npm run build                          # type-check (tsc) + Vite build of web assets only

npm run tauri build                    # package: .deb + AppImage
npm run tauri build -- --bundles deb   # .deb only (skip AppImage)
```

When developing, you only need `npm run tauri dev`. `npm run build` is rarely run by itself — `npm run tauri build` invokes it for you. The "chunks larger than 500 kB" message during the web build is an informational warning, not an error.

Bundles are written to `src-tauri/target/release/bundle/`:
- `.deb` → `deb/Dexter Managing Software_0.1.0_amd64.deb`
- AppImage → `appimage/Dexter Managing Software_0.1.0_amd64.AppImage`

---

## Install the app

Install the `.deb` (registers it in the app menu + dock with the icon):

```bash
sudo dpkg -i "src-tauri/target/release/bundle/deb/Dexter Managing Software_0.1.0_amd64.deb"
sudo apt -f install     # only if dpkg reports missing dependencies
```

Launch **“Dexter Managing Software”** from the GNOME app grid, or run `todo` (the binary is `/usr/bin/todo`). Uninstall with `sudo apt remove dexter-managing-software`.

Or run the **AppImage** (portable, no install):
```bash
chmod +x "src-tauri/target/release/bundle/appimage/Dexter Managing Software_0.1.0_amd64.AppImage"
"src-tauri/target/release/bundle/appimage/Dexter Managing Software_0.1.0_amd64.AppImage"
```

After changing code: `npm run tauri build` → reinstall the `.deb` → relaunch. The installed app needs no `npm` at runtime.

---

## Troubleshooting

- **AppImage build fails: `failed to run linuxdeploy` / `librsvg-2.0.pc … missing`.** The GTK bundling plugin needs `librsvg-2.0.pc`. Fix permanently with `sudo apt install librsvg2-dev`, then `npm run tauri build`. (Workaround without sudo: create a minimal `librsvg-2.0.pc` and build with `PKG_CONFIG_PATH=/that/dir npm run tauri build`.) The `.deb` is unaffected.
- **`dpkg` says a file is "also in package ai-whiteboard".** That's the old‑named package. Remove it first: `sudo apt remove ai-whiteboard`, then install the `dexter-managing-software` deb. (Both ship `/usr/bin/todo`.)
- **Dock shows a generic gear icon in dev.** On Wayland/GNOME the dock icon comes from an installed `.desktop`. In `npm run tauri dev` there isn't one, so it falls back. Install the `.deb` (or use the bundled dev `.desktop`) to get the real icon.
- **Shift+Tab / a UI change "doesn't work" after editing.** Vite HMR doesn't always re‑attach global listeners — fully reload the window (Ctrl+R) or restart `tauri dev`.
- **Agent says "run `claude login`".** The `claude` CLI isn't logged in or isn't on PATH; run `claude login`.
- **No tasks load / 401.** The ClickUp token is wrong or empty — re‑enter it in ⚙ settings.

---

## Notes & limitations

- Comments are **read‑only** in the drawer.
- Markdown links open in your **system browser** (they don't navigate the app).
- The internal data dir stays `~/.ai-whiteboard/` and the bundle identifier `com.dexter.whiteboard` even though the product is now "Dexter Managing Software" — renaming those would orphan saved data / break the installed‑app mapping.
- The GitHub repo is named `ai-whiteboard`; the *app* product name is "Dexter Managing Software".
