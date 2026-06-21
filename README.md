# Dexter Managing Software

A local **Tauri desktop app** that puts your ClickUp work and an embedded **Claude Code** agent side by side — manage tickets, sketch them out on per‑task whiteboards, and let an AI agent work in your project folder, all in one window. It runs entirely on your machine and uses your existing Claude login (no API key).

---

## Features

### ClickUp tasks
- Connect with a ClickUp **personal token** (`pk_…`) entered in‑app.
- See the tasks **assigned to you** across all workspaces, grouped by status with **In Progress pinned to the top** and collapsible sections.
- Each row shows title, status, priority, due date (relative + overdue highlight), assignee avatars, and tags.

### Task detail drawer
Click a task to open a slide‑over drawer with the full ticket:
- **Rendered markdown** description (sanitized) and **read‑only comments**, plus assignees, tags, priority, and due/start dates.
- **Change status right from the badge** — writes back to ClickUp and re‑groups the list live.
- **Open in ClickUp** (opens in your system browser).
- **Split view** toggle — details on the left, work area on the right.
- Tabs: **Details · Board · ✨ Ask Claude**.
- A **per‑task Excalidraw board** (persisted per ticket) with an AI **“Generate diagram”** prompt that draws onto that task's board.
- Image **lightbox** (click to zoom) and smooth slide‑in/out animations.

### Task whiteboard
A local, freeform board of task cards:
- **Add cards** three ways — pick from your tasks, paste a ClickUp link/id, or **drag a task from the sidebar**.
- **Drag to arrange**, **click to open** the ticket, **✕ to remove** (board only — never deletes the ClickUp ticket).
- Layout **persists locally**. Toggle it from the **Claude Code | Board** tab above the task list.

### Claude Code agent
A real Claude Code session embedded in the app:
- **Side‑by‑side panel** plus a **per‑ticket assistant** (the Ask Claude tab) that gets the ticket as context.
- **Streaming** output and live tool activity.
- **Model** (Opus / Sonnet / Haiku / Fable), **effort** (low → max), and **permission** (read‑only / auto‑edits / auto / full) controls. **Shift+Tab** cycles the permission mode, like the CLI.
- **Slash‑command autocomplete** — built‑ins (`/code-review`, `/review`, `/init`, `/model`, `/effort`, …) plus your custom commands discovered from `.claude/commands/`.
- Native **folder picker** for the work directory; sessions persist and resume.

### Polish
Inter typeface, solid white‑on‑color status/tag badges (auto‑darkened for legibility), a custom app icon, and consistent spacing throughout.

---

## How it works

- **Frontend:** React 19 + TypeScript (Vite). UI state is local React; pure logic (status grouping, relative dates, badge colors, slash parsing, the agent stream reducer) lives in `src/lib/` and is unit‑tested.
- **Backend:** Rust (Tauri v2). ClickUp REST calls go through `reqwest` (rustls); the AI features **shell out to your local `claude` CLI** (using your Max/Pro login — no API key is stored or required). The agent streams `claude -p --output-format stream-json` back to the UI over a Tauri IPC channel, with cancellation via process‑group kill.
- **Storage (local only):** `~/.ai-whiteboard/` holds `config.json` (your token), per‑task boards (`tasks/`), and agent sessions (`agent/`). Nothing is sent anywhere except ClickUp's API and your local `claude`.

---

## Tech stack

Tauri v2 (Rust) · React 19 + TypeScript · Vite · Excalidraw · marked + DOMPurify · `@fontsource-variable/inter` · vitest · reqwest.

## Project structure

```
src/
  App.tsx                 # layout: task sidebar (left) + Claude Code / Board (right)
  components/
    TaskPanel.tsx         # ClickUp task list, grouped by status
    TaskRow.tsx, StatusGroup.tsx, Avatar.tsx
    TaskDrawer.tsx        # ticket detail: markdown, comments, status, board, Ask Claude
    TaskBoard.tsx         # freeform local board of task cards
    AgentPanel.tsx        # standalone Claude Code session
    AgentChat.tsx         # streaming chat + slash-command menu
    ui.ts                 # design tokens + color helpers
  hooks/useAgentSession.ts
  lib/                    # clickup, agent, format, markdown, assistant, errors (+ *.test.ts)
src-tauri/src/lib.rs      # all Tauri commands (ClickUp, agent runner, scenes, dialog, slash cmds)
```

---

## Prerequisites

- **Node.js** 18+ and npm
- **Rust** (stable) + Cargo
- The **`claude` CLI** installed and logged in (`claude login`) — required for the AI features
- Linux build/runtime deps (Ubuntu):
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev
  ```
  > `librsvg2-dev` is needed for the **AppImage** bundle step (provides `librsvg-2.0.pc`); without it the `.deb` still builds.

## Getting started (development)

```bash
npm install
npm run tauri dev      # launches the desktop app with hot reload
```
On first launch, open the task panel's **⚙ settings**, paste your ClickUp `pk_…` token, and **Save & Refresh**. Set a work folder in the Claude Code panel to use the agent.

## Testing

```bash
npm test               # vitest — pure-logic unit tests
npm run build          # tsc type-check + Vite production build (web assets only)
```

## Building & installing

```bash
npm run tauri build                    # builds .deb + AppImage (per tauri.conf.json)
npm run tauri build -- --bundles deb   # .deb only (skip AppImage)
```
Artifacts land in `src-tauri/target/release/bundle/`:

- **`.deb`** → `deb/Dexter Managing Software_0.1.0_amd64.deb`
- **AppImage** → `appimage/Dexter Managing Software_0.1.0_amd64.AppImage` (needs `librsvg2-dev`)

Install the `.deb` (registers it in the app menu + dock with the icon):
```bash
sudo dpkg -i "src-tauri/target/release/bundle/deb/Dexter Managing Software_0.1.0_amd64.deb"
sudo apt -f install     # if dpkg reports missing dependencies
```
Then launch **“Dexter Managing Software”** from the app grid. Uninstall with `sudo apt remove dexter-managing-software`.

Or run the AppImage directly (portable, no install): `chmod +x …AppImage && ./…AppImage`.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| **Shift+Tab** | Cycle the Claude Code permission mode |
| **/** (in chat) | Open the slash‑command menu (↑/↓ to navigate, Tab/Enter to insert, Esc to dismiss) |
| **Enter / Shift+Enter** | Send / newline in the chat |
| **Esc** | Close the ticket drawer (Details tab) or the slash menu |

## Privacy

Your ClickUp token and all app data stay on your machine under `~/.ai-whiteboard/` and are never committed to the repo. The AI agent runs as you, via your local `claude` login — no API key is stored.
