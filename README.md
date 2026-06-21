# AI Whiteboard — ClickUp tasks + Claude Code

A local Tauri desktop app that brings your ClickUp work and an embedded Claude Code agent into one window.

## Features

- **ClickUp tasks** — connect with a personal token and see the tasks assigned to you, grouped by status (In Progress pinned on top).
- **Task detail drawer** — full ticket with rendered markdown description, comments, assignees, tags, priority and due dates. Change a task's **status right from the badge**, open it in ClickUp, and use the **split view** (details left, board right). Each task gets its own **Excalidraw drawing board** (with AI "Generate diagram") and an **Ask Claude** assistant.
- **Task whiteboard** — a local board where you pin task cards (pick from your list, paste a ClickUp link/id, or drag from the sidebar), arrange them freely, and click to open the ticket. Removing a card only affects the board — never the ClickUp ticket.
- **Claude Code agent** — a side-by-side Claude Code session in a work folder of your choice: streaming output and tool activity, slash-command autocomplete, model / effort / permission controls (Shift+Tab cycles the permission mode), and a native folder picker.

## Tech

Tauri v2 (Rust) · React 19 + TypeScript · Vite · Excalidraw · marked + DOMPurify · vitest.

## Develop

```bash
npm install
npm run tauri dev      # run the desktop app
npm test               # unit tests (pure logic)
npm run build          # type-check + build the web assets
npm run tauri build    # package (.deb / AppImage)
```

Your ClickUp token is entered in-app and stored locally under `~/.ai-whiteboard/` (alongside saved boards and agent sessions) — it is never committed.
