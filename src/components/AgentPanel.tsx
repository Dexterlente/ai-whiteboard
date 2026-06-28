import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AgentChat } from "./AgentChat";
import {
  AGENT_EFFORT_KEY as EFFORT_KEY,
  AGENT_FOLDER_KEY as FOLDER_KEY,
  AGENT_MODEL_KEY as MODEL_KEY,
  AGENT_PERM_KEY as PERM_KEY,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  PERM_OPTIONS,
  sessionKeyForFolder,
  type PermissionMode,
} from "../lib/agent";
import { colors, radius, space } from "./ui";

/** The standalone Claude Code panel: pick a work folder + permission level, then chat. */
export function AgentPanel() {
  const [folder, setFolder] = useState(() => localStorage.getItem(FOLDER_KEY) ?? "");
  // `draft` is what's in the input; `folder` is the committed value (drives the chat session +
  // its key). Committing only on blur/Enter/picker avoids remounting AgentChat on every keystroke.
  const [draft, setDraft] = useState(folder);
  const [mode, setMode] = useState<PermissionMode>(
    () => (localStorage.getItem(PERM_KEY) as PermissionMode) || "acceptEdits",
  );
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
  const [effort, setEffort] = useState(() => localStorage.getItem(EFFORT_KEY) ?? "");

  function updateFolder(v: string) {
    setFolder(v);
    setDraft(v);
    localStorage.setItem(FOLDER_KEY, v);
  }
  function updateMode(v: PermissionMode): boolean {
    if (
      v === "full" &&
      !window.confirm(
        "Full mode lets the agent run ANY command in this folder without asking. Continue?",
      )
    ) {
      return false;
    }
    setMode(v);
    localStorage.setItem(PERM_KEY, v);
    return true;
  }

  function updateModel(v: string) {
    setModel(v);
    localStorage.setItem(MODEL_KEY, v);
  }
  function updateEffort(v: string) {
    setEffort(v);
    localStorage.setItem(EFFORT_KEY, v);
  }

  async function pickFolder() {
    try {
      const dir = await open({ directory: true, multiple: false, title: "Select work folder" });
      if (typeof dir === "string") updateFolder(dir);
    } catch (e) {
      console.error("Folder picker failed", e); // e.g. no desktop portal on Linux
    }
  }

  // Shift+Tab always cycles the permission mode globally (Claude-CLI style) — capture phase +
  // preventDefault means it never moves focus, even inside inputs/selects/the chat box.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // On Linux/GTK, Shift+Tab emits the `ISO_Left_Tab` keysym (so `e.key` may not be "Tab").
      // Detect by physical key (`e.code`) + the ISO keysym so it works across platforms.
      const shiftTab =
        e.key === "ISO_Left_Tab" || ((e.code === "Tab" || e.key === "Tab") && e.shiftKey);
      if (!shiftTab) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const active = document.activeElement as HTMLElement | null;
      const order = PERM_OPTIONS.map((o) => o.value);
      const next = order[(order.indexOf(modeRef.current) + 1) % order.length];
      // If "full" is declined at the confirm, skip past it instead of re-prompting forever.
      if (!updateMode(next) && next === "full") updateMode(order[0]);
      // WebKitGTK ignores preventDefault for Tab focus, so put focus back next frame.
      requestAnimationFrame(() => {
        if (document.activeElement === active) return;
        if (active && active !== document.body && typeof active.focus === "function") active.focus();
        else (document.activeElement as HTMLElement | null)?.blur?.();
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const folderSet = folder.trim().length > 0;

  return (
    <div style={wrapStyle}>
      <div style={barStyle}>
        <div style={{ display: "flex", flexDirection: "column", gap: space(1), flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>Work folder</label>
          <div style={{ display: "flex", gap: space(2) }}>
            <input
              style={inputStyle}
              value={draft}
              title={draft || undefined}
              placeholder="/absolute/path/to/your/project"
              spellCheck={false}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onBlur={() => updateFolder(draft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") updateFolder(draft);
              }}
            />
            <button style={openBtnStyle} onClick={pickFolder}>
              Open…
            </button>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Permission</label>
          <select
            style={selectStyle}
            value={mode}
            onChange={(e) => updateMode(e.currentTarget.value as PermissionMode)}
          >
            {PERM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 11, color: colors.textMuted }}>⇧Tab to cycle</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Model</label>
          <select style={selectStyle} value={model} onChange={(e) => updateModel(e.currentTarget.value)}>
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Effort</label>
          <select style={selectStyle} value={effort} onChange={(e) => updateEffort(e.currentTarget.value)}>
            {EFFORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={hintStyle}>
        The agent runs as you, with your Claude login, and can read/modify files and run commands in
        this folder.
      </div>
      <AgentChat
        key={folder}
        sessionKey={folderSet ? sessionKeyForFolder(folder) : "panel-none"}
        cwd={folder}
        permissionMode={mode}
        model={model}
        effort={effort}
        disabledReason={folderSet ? undefined : "Set a work folder above to start."}
      />
    </div>
  );
}

const wrapStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: colors.bg,
};
const barStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  flexWrap: "wrap",
  gap: space(3),
  padding: `${space(3)}px ${space(4)}px ${space(2)}px`,
  background: colors.surface,
  borderBottom: `1px solid ${colors.border}`,
};
const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: colors.textFaint,
};
const CONTROL_H = 36;
const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: CONTROL_H,
  boxSizing: "border-box",
  padding: `0 ${space(2.5)}px`,
  fontSize: 13,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  outline: "none",
};
const openBtnStyle: CSSProperties = {
  flexShrink: 0,
  height: CONTROL_H,
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  padding: `0 ${space(3)}px`,
  fontSize: 13,
  fontWeight: 600,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  background: colors.surface,
  color: colors.text,
  cursor: "pointer",
};
const selectStyle: CSSProperties = {
  height: CONTROL_H,
  boxSizing: "border-box",
  padding: `0 ${space(2)}px`,
  fontSize: 13,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  background: colors.surface,
  cursor: "pointer",
};
const hintStyle: CSSProperties = {
  padding: `${space(1.5)}px ${space(4)}px`,
  fontSize: 11.5,
  color: colors.textFaint,
  background: colors.surface,
  borderBottom: `1px solid ${colors.border}`,
};
