import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Excalidraw, exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import { invoke } from "@tauri-apps/api/core";
import {
  fetchComments,
  fetchListStatuses,
  fetchTaskDetail,
  loadTaskScene,
  openExternal,
  saveTaskScene,
  setStatus,
  type ClickUpTask,
  type Comment,
} from "../lib/clickup";
import { generateDiagram } from "../lib/claude";
import { diagramToElements } from "../lib/toExcalidraw";
import { renderMarkdown } from "../lib/markdown";
import { relativeDate } from "../lib/format";
import { toMessage } from "../lib/errors";
import { Avatar } from "./Avatar";
import { AssistantTab } from "./AssistantTab";
import { AgentChat } from "./AgentChat";
import { buildAgentTicketContext, buildDiagramContext } from "../lib/assistant";
import { getAgentFolder, getAgentPermission } from "../lib/agent";
import { colors, radius, space, PRIORITY_COLOR, solidBadgeBg, tagColors } from "./ui";

const serialize = (api: any): string =>
  serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local");

/** Slide-over drawer showing a task's full details, comments, and its own drawing board. */
export function TaskDrawer({
  task,
  onClose,
  onTaskUpdated,
}: {
  task: ClickUpTask;
  onClose: () => void;
  onTaskUpdated?: (t: ClickUpTask) => void;
}) {
  const [detail, setDetail] = useState<ClickUpTask | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "board" | "assistant">("details");
  const [view, setView] = useState<"tabs" | "split">(() =>
    typeof localStorage !== "undefined" && localStorage.getItem("cu-drawer-view") === "split"
      ? "split"
      : "tabs",
  );
  const [boardMounted, setBoardMounted] = useState(view === "split");
  const [boardReady, setBoardReady] = useState(false);
  const [assistantMounted, setAssistantMounted] = useState(false);
  const [assistantMode, setAssistantMode] = useState<"actions" | "agent">(() =>
    typeof localStorage !== "undefined" && localStorage.getItem("cu-assistant-mode") === "agent"
      ? "agent"
      : "actions",
  );
  const [agentSeen, setAgentSeen] = useState(() => assistantMode === "agent");
  const [visible, setVisible] = useState(false);

  // AI generate-into-board state.
  const [genPrompt, setGenPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Lightbox for zooming description images.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const apiRef = useRef<any>(null);
  const boardLoaded = useRef(false); // true once the saved scene has been applied
  const loadFailedRef = useRef(false); // true if an existing scene file failed to parse → never overwrite it
  const saveTimer = useRef<number | null>(null);
  const generatingRef = useRef(false); // concurrency guard (state lags a frame; a ref blocks double-fire)

  // Trigger the slide-in transition. Flip on a later frame (double rAF) so the browser first
  // paints the off-screen translateX(100%) state — otherwise there's nothing to animate from.
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setVisible(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  // Animate out, then let the parent unmount us (matches the 0.22s slide transition).
  const closeTimer = useRef<number | null>(null);
  const closing = useRef(false);
  function requestClose() {
    if (closing.current) return;
    closing.current = true;
    setVisible(false);
    closeTimer.current = window.setTimeout(onClose, 230);
  }
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  // Close on Escape — but not while the board is shown (Excalidraw owns Escape there).
  // The status dropdown handles its own Escape via a capture listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && view === "tabs" && tab !== "board" && tab !== "assistant") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, tab, view]);

  // Fetch full detail + comments. A comments failure must not hide the (successfully
  // fetched) description, so settle the two independently. Exposed as a callback so the
  // assistant + status picker can re-run it after they write a change.
  const reqId = useRef(0);
  const loadDetail = useCallback(async () => {
    const myReq = ++reqId.current;
    setLoadingDetail(true);
    setErrorDetail(null);
    const [dRes, cRes] = await Promise.allSettled([fetchTaskDetail(task.id), fetchComments(task.id)]);
    if (myReq !== reqId.current) return; // a newer load (or unmount) superseded this one
    if (dRes.status === "fulfilled") setDetail(dRes.value);
    else setErrorDetail(toMessage(dRes.reason));
    if (cRes.status === "fulfilled") setComments(cRes.value);
    setLoadingDetail(false);
  }, [task.id]);

  useEffect(() => {
    void loadDetail();
    return () => {
      reqId.current++; // invalidate any in-flight load on unmount / task change
    };
  }, [loadDetail]);

  // Flush the board to disk on close/unmount — but only if it actually loaded,
  // so closing mid-load never overwrites the saved drawing with a blank canvas.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const api = apiRef.current;
      if (api && boardLoaded.current && !loadFailedRef.current)
        saveTaskScene(task.id, serialize(api)).catch(() => {});
    };
  }, [task.id]);

  // Close the image lightbox on Escape (capture so it beats the drawer's Escape).
  useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setLightboxSrc(null);
        setZoomed(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [lightboxSrc]);

  function applyView(v: "tabs" | "split") {
    setView(v);
    try {
      localStorage.setItem("cu-drawer-view", v);
    } catch {
      // ignore storage failures (private mode, etc.)
    }
    if (v === "split") setBoardMounted(true);
  }

  async function loadBoard(api: any) {
    apiRef.current = api;
    try {
      const raw = await loadTaskScene(task.id);
      if (raw) {
        try {
          const scene = JSON.parse(raw);
          const files = scene.files ?? {};
          if (Object.keys(files).length) api.addFiles(Object.values(files));
          api.updateScene({ elements: scene.elements ?? [] });
        } catch {
          // An existing board file is corrupt — don't auto-save over it (preserve for recovery).
          loadFailedRef.current = true;
        }
      }
    } catch {
      // couldn't read the file (none yet / IO error) → safe to start blank and save
    } finally {
      boardLoaded.current = true;
      setBoardReady(true);
    }
  }

  function scheduleSave() {
    // bail if not loaded yet, or if the existing file was corrupt (don't clobber it)
    if (!apiRef.current || !boardLoaded.current || loadFailedRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (apiRef.current) saveTaskScene(task.id, serialize(apiRef.current)).catch(() => {});
    }, 800);
  }

  // Resolve once the board is mounted AND its saved scene has been applied. Mounting
  // Excalidraw is async (loadBoard runs on its excalidrawAPI callback), so callers that
  // just flipped boardMounted on must wait for the API before pushing elements.
  function waitForBoard(timeoutMs = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (apiRef.current && boardLoaded.current) return resolve(apiRef.current);
        if (Date.now() - start > timeoutMs) return reject(new Error("The board didn't load in time — try again."));
        window.setTimeout(tick, 80);
      };
      tick();
    });
  }

  // Shift a freshly generated batch down so it sits below `existing` (previous diagrams,
  // manual drawings) instead of stacking on top at the same coordinates.
  function placeBelowExisting(existing: any[], els: any[]): any[] {
    if (!els.length || !existing.length) return els; // empty board → place as generated
    let existingBottom = -Infinity;
    for (const e of existing) existingBottom = Math.max(existingBottom, (e.y ?? 0) + (e.height ?? 0));
    let newTop = Infinity;
    for (const e of els) newTop = Math.min(newTop, e.y ?? 0);
    const dy = existingBottom + 80 - newTop;
    if (dy <= 0) return els; // already clear of existing content
    return els.map((e) => ({ ...e, y: (e.y ?? 0) + dy }));
  }

  // Generate a diagram and draw it onto THIS ticket's board. Shared by the board toolbar
  // and the "Flowchart → board" button in Ask Claude (which may need the board mounted first).
  async function generateOntoBoard(prompt: string) {
    if (!prompt.trim() || generatingRef.current) return; // ref guard: blocks a double-fire before state flips
    generatingRef.current = true;
    setBoardMounted(true); // ensure the board exists…
    setTab("board"); // …and is the visible pane so the user sees the result
    setGenerating(true);
    setGenError(null);
    try {
      const api = await waitForBoard();
      if (loadFailedRef.current) {
        // Saved scene is corrupt → scheduleSave/unmount-save are suppressed, so anything we
        // draw now would be silently lost. Fail loudly instead of wasting a Claude call.
        setGenError("This board's saved drawing couldn't be read, so new changes won't be saved. Clear or fix it first.");
        return;
      }
      const ctx = buildDiagramContext(task, detail, comments);
      const diagram = await generateDiagram(prompt, ctx);
      const existing = api.getSceneElements();
      const els = placeBelowExisting(existing, diagramToElements(diagram));
      api.updateScene({ elements: [...existing, ...els] }); // append, don't wipe
      if (els.length) api.scrollToContent(els, { fitToContent: true });
      // the resulting onChange auto-saves
    } catch (e) {
      setGenError(toMessage(e));
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  }

  function handleGenerate() {
    void generateOntoBoard(genPrompt);
  }

  async function handleExport() {
    const api = apiRef.current;
    if (!api) return;
    setGenError(null);
    try {
      const els = api.getSceneElements();
      if (!els.length) {
        setGenError("Nothing to export yet — draw or generate something first.");
        return;
      }
      const blob = await exportToBlob({ elements: els, files: api.getFiles(), mimeType: "image/png" });
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      await invoke<string>("save_png", { bytes });
    } catch (e) {
      setGenError(toMessage(e));
    }
  }

  async function handleStatusChange(newStatus: string) {
    await setStatus(task.id, newStatus); // throws → StatusPicker surfaces the error (change failed)
    // The change landed in ClickUp; reflect it locally now so a re-fetch failure can't desync the UI.
    // Clear the color too so the pill shows neutral (not the OLD status color) until the refetch.
    setDetail((prev) => (prev ? { ...prev, status: newStatus, statusColor: null } : prev));
    try {
      const updated = await fetchTaskDetail(task.id); // refresh accurate color/type/orderindex
      setDetail(updated);
      onTaskUpdated?.(updated); // regroup the list under the new status
    } catch {
      // status already applied locally; the list syncs on the next manual refresh
    }
  }

  const d = detail ?? task;
  const due = d.dueDate ? Number(d.dueDate) : NaN;
  const start = d.startDate ? Number(d.startDate) : NaN;
  const descHtml = renderMarkdown(
    detail?.markdownDescription || detail?.textDescription || "_No description_",
  );

  return (
    <>
      <div onClick={requestClose} style={{ ...backdropStyle, opacity: visible ? 1 : 0 }} />
      <aside
        style={{
          ...drawerStyle,
          width: view === "split" ? "80vw" : "min(760px, 70vw)",
          transform: visible ? "translateX(0)" : "translateX(100%)",
        }}
      >
        <header style={headerStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: space(2), marginBottom: space(1.5) }}>
              <StatusPicker
                status={d.status}
                color={d.statusColor}
                listId={d.listId}
                onChange={handleStatusChange}
              />
              {d.priority && (
                <span style={{ color: d.priorityColor || PRIORITY_COLOR[d.priority] || colors.textMuted, fontSize: 12, fontWeight: 600 }}>
                  ⚑ {d.priority}
                </span>
              )}
            </div>
            <h2 style={titleStyle}>{d.name}</h2>
            {d.listName && <div style={{ fontSize: 12, color: colors.textFaint, marginTop: space(1) }}>{d.listName}</div>}
          </div>
          <button onClick={requestClose} aria-label="Close" style={iconBtnStyle}>
            ✕
          </button>
        </header>

        <nav style={tabBarStyle}>
          {/* In split mode, details is always on the left, so the tabs switch the RIGHT pane. */}
          {view === "tabs" && (
            <button onClick={() => setTab("details")} style={tabStyle(tab === "details")}>
              Details
            </button>
          )}
          <button
            onClick={() => { setTab("board"); setBoardMounted(true); }}
            style={tabStyle(view === "split" ? tab !== "assistant" : tab === "board")}
          >
            🖉 Board
          </button>
          <button
            onClick={() => { setTab("assistant"); setAssistantMounted(true); }}
            style={tabStyle(tab === "assistant")}
          >
            ✨ Ask Claude
          </button>
          <button onClick={() => applyView(view === "split" ? "tabs" : "split")} style={toggleBtnStyle} title="Toggle split view">
            {view === "split" ? "▭ Tabbed" : "⇆ Split view"}
          </button>
        </nav>

        <div style={contentRowStyle}>
          {/* Details */}
          <div
            style={{
              ...bodyStyle,
              ...(view === "split" ? splitDetailsStyle : {}),
              display: view === "split" || tab === "details" ? "block" : "none",
            }}
          >
            {errorDetail && <div style={errorStyle}>{errorDetail}</div>}

            <div style={metaGridStyle}>
              {Number.isFinite(due) && due > 0 && (
                <Field label="Due">
                  <span title={new Date(due).toLocaleString()}>{relativeDate(due, Date.now())}</span>
                </Field>
              )}
              {Number.isFinite(start) && start > 0 && (
                <Field label="Start">
                  <span title={new Date(start).toLocaleString()}>{relativeDate(start, Date.now())}</span>
                </Field>
              )}
              {d.assignees.length > 0 && (
                <Field label="Assignees">
                  <span style={{ display: "inline-flex", alignItems: "center" }}>
                    {d.assignees.map((a, i) => (
                      <Avatar key={i} name={a.username} color={a.color} init={a.initials} />
                    ))}
                  </span>
                </Field>
              )}
            </div>

            {d.tags.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: space(1.5), marginBottom: space(4) }}>
                {d.tags.map((tg, i) => {
                  const { bg, fg } = tagColors(tg);
                  return (
                    <span key={`${tg.name}-${i}`} style={{ ...pillStyle, background: bg, color: fg, fontSize: 11 }}>
                      {tg.name}
                    </span>
                  );
                })}
              </div>
            )}

            <SectionTitle>Description</SectionTitle>
            {loadingDetail ? (
              <div style={skeletonStyle} />
            ) : (
              <div
                className="cu-markdown"
                onClick={(e) => {
                  // Links are handled globally (see markdown.ts) so they open externally; here just images.
                  const el = e.target as HTMLElement;
                  if (el.tagName === "IMG") {
                    const src = (el as HTMLImageElement).src;
                    if (src) {
                      setZoomed(false);
                      setLightboxSrc(src);
                    }
                  }
                }}
                dangerouslySetInnerHTML={{ __html: descHtml }}
              />
            )}

            <SectionTitle>Comments {comments.length > 0 && `(${comments.length})`}</SectionTitle>
            {loadingDetail ? (
              <div style={skeletonStyle} />
            ) : comments.length === 0 ? (
              <div style={{ color: colors.textFaint, fontSize: 13 }}>No comments.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: space(3) }}>
                {comments.map((c) => {
                  const ts = c.date ? Number(c.date) : NaN;
                  return (
                    <div key={c.id} style={{ display: "flex", gap: space(2.5) }}>
                      <Avatar name={c.author} color={c.authorColor} init={c.authorInitials} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, marginBottom: 2 }}>
                          <strong style={{ color: colors.text }}>{c.author || "Unknown"}</strong>{" "}
                          {Number.isFinite(ts) && ts > 0 && <span style={{ color: colors.textFaint }}>· {relativeDate(ts, Date.now())}</span>}
                        </div>
                        <div style={{ fontSize: 13, color: colors.text, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{c.text}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {task.url && (
              <button onClick={() => void openExternal(task.url!).catch(() => {})} className="primary" style={openBtnStyle}>
                Open in ClickUp ↗
              </button>
            )}
          </div>

          {/* Board (lazy-mounted, kept alive once opened) */}
          {boardMounted && (
            <div style={{ ...boardPaneStyle, display: (view === "split" ? tab !== "assistant" : tab === "board") ? "flex" : "none" }}>
              <div style={boardToolbarStyle}>
                <input
                  style={boardInputStyle}
                  value={genPrompt}
                  placeholder='Generate on this board — e.g. "flowchart for login"'
                  onChange={(e) => setGenPrompt(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleGenerate();
                  }}
                  disabled={generating || !boardReady}
                />
                <button
                  className="primary"
                  onClick={handleGenerate}
                  disabled={generating || !boardReady || !genPrompt.trim()}
                  style={boardBtnStyle}
                >
                  {generating ? "Working…" : "Generate"}
                </button>
                <button onClick={handleExport} disabled={!boardReady} style={boardBtnStyle}>
                  Export PNG
                </button>
              </div>
              {genError && <div style={genErrorStyle}>{genError}</div>}
              <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                <Excalidraw excalidrawAPI={loadBoard} onChange={scheduleSave} />
              </div>
            </div>
          )}

          {/* Ask Claude (lazy-mounted, kept alive once opened so the chat persists) */}
          {assistantMounted && (
            <div style={{ ...boardPaneStyle, display: tab === "assistant" ? "flex" : "none", flexDirection: "column" }}>
              <div style={{ display: "flex", gap: space(1), padding: `${space(1.5)}px ${space(4)}px`, borderBottom: `1px solid ${colors.border}` }}>
                {(["actions", "agent"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setAssistantMode(m);
                      try {
                        localStorage.setItem("cu-assistant-mode", m);
                      } catch {
                        /* ignore storage failures */
                      }
                      if (m === "agent") setAgentSeen(true);
                    }}
                    style={{
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      padding: `${space(1)}px ${space(2)}px`,
                      color: assistantMode === m ? colors.accent : colors.textMuted,
                      borderBottom: `2px solid ${assistantMode === m ? colors.accent : "transparent"}`,
                    }}
                  >
                    {m === "actions" ? "Actions" : "✨ Agent"}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, minHeight: 0, display: assistantMode === "actions" ? "flex" : "none", flexDirection: "column" }}>
                <AssistantTab
                  task={task}
                  detail={detail}
                  comments={comments}
                  onApplied={loadDetail}
                  onGenerateFlowchart={generateOntoBoard}
                  flowchartBusy={generating}
                />
              </div>
              {agentSeen && (
                <div style={{ flex: 1, minHeight: 0, display: assistantMode === "agent" ? "flex" : "none", flexDirection: "column" }}>
                  <AgentChat
                    key={task.id}
                    sessionKey={`task-${task.id}`}
                    cwd={getAgentFolder()}
                    permissionMode={getAgentPermission()}
                    appendSystemPrompt={buildAgentTicketContext(task, detail, comments, new Date().toISOString().slice(0, 10))}
                    placeholder="Ask Claude to work on this ticket in your project folder…"
                    disabledReason={
                      !getAgentFolder().trim()
                        ? "Set a work folder in the Claude Code tab first."
                        : loadingDetail
                          ? "Loading ticket…"
                          : undefined
                    }
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {lightboxSrc && (
        <div
          onClick={() => {
            setLightboxSrc(null);
            setZoomed(false);
          }}
          style={lightboxStyle}
        >
          <img
            src={lightboxSrc}
            alt=""
            onClick={(e) => {
              e.stopPropagation();
              setZoomed((z) => !z);
            }}
            style={zoomed ? lightboxImgZoomedStyle : lightboxImgStyle}
          />
        </div>
      )}
    </>
  );
}

/** The status badge, clickable to change the task's ClickUp status. */
function StatusPicker({
  status,
  color,
  listId,
  onChange,
}: {
  status: string;
  color: string | null;
  listId: string | null;
  onChange: (s: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // capture so closing the dropdown beats the drawer's bubble-phase Escape handler.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  async function toggle() {
    if (!listId) return;
    const next = !open;
    setOpen(next);
    if (next && options === null) {
      try {
        setOptions(await fetchListStatuses(listId));
      } catch (e) {
        setErr(toMessage(e));
        setOptions([]);
      }
    }
  }

  async function pick(name: string) {
    if (name === status) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onChange(name);
      setOpen(false);
    } catch (e) {
      setErr(toMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const bg = solidBadgeBg(color);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={toggle}
        disabled={!listId || busy}
        title={status || (listId ? "Change status" : undefined)}
        style={{
          ...pillStyle,
          background: bg,
          color: "#ffffff",
          border: "none",
          cursor: listId ? "pointer" : "default",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          maxWidth: 240,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {busy ? "…" : status || "—"}
        </span>
        {listId && <span style={{ fontSize: 9, flexShrink: 0 }}>▾</span>}
      </button>
      {open && (
        <div style={statusMenuStyle}>
          {options === null ? (
            <div style={statusMenuItemStyle}>Loading…</div>
          ) : options.length === 0 ? (
            <div style={statusMenuItemStyle}>{err || "No statuses"}</div>
          ) : (
            options.map((o) => (
              <button
                key={o}
                onClick={() => pick(o)}
                style={{
                  ...statusMenuBtnStyle,
                  fontWeight: o === status ? 700 : 400,
                  background: o === status ? colors.surfaceAlt : "transparent",
                }}
              >
                <span style={{ width: 14, flexShrink: 0, color: colors.accent }}>{o === status ? "✓" : ""}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o}</span>
              </button>
            ))
          )}
          {err && options && options.length > 0 && (
            <div style={{ ...statusMenuItemStyle, color: colors.danger }}>{err}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: colors.textFaint, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: colors.text }}>{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: colors.textMuted, margin: `${space(5)}px 0 ${space(2)}px` }}>
      {children}
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 18, 26, 0.35)",
  transition: "opacity 0.22s ease",
  zIndex: 40,
};

const drawerStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  height: "100vh",
  background: colors.surface,
  boxShadow: colors.shadow,
  display: "flex",
  flexDirection: "column",
  transition: "transform 0.22s ease, width 0.22s ease",
  zIndex: 41,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: space(3),
  padding: `${space(4)}px ${space(5)}px ${space(3)}px`,
  borderBottom: `1px solid ${colors.border}`,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 650,
  color: colors.text,
  lineHeight: 1.3,
};

const iconBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${colors.border}`,
  background: colors.surface,
  borderRadius: radius.sm,
  width: 30,
  height: 30,
  cursor: "pointer",
  color: colors.textMuted,
  flexShrink: 0,
  fontSize: 14,
  lineHeight: 1,
};

const tabBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(1),
  padding: `0 ${space(5)}px`,
  borderBottom: `1px solid ${colors.border}`,
};

const tabStyle = (active: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: "none",
  background: "transparent",
  padding: `${space(2.5)}px ${space(2)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  color: active ? colors.accent : colors.textMuted,
  borderBottom: `2px solid ${active ? colors.accent : "transparent"}`,
  marginBottom: -1,
});

const toggleBtnStyle: CSSProperties = {
  marginLeft: "auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: `1px solid ${colors.border}`,
  background: colors.surface,
  borderRadius: radius.sm,
  padding: `${space(1.5)}px ${space(2.5)}px`,
  fontSize: 12,
  fontWeight: 600,
  color: colors.textMuted,
  cursor: "pointer",
  alignSelf: "center",
};

const contentRowStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: `${space(4)}px ${space(5)}px`,
};

const splitDetailsStyle: CSSProperties = {
  flex: "none",
  width: 440,
  flexShrink: 0,
  borderRight: `1px solid ${colors.border}`,
};

const boardPaneStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  flexDirection: "column",
};

const boardToolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  padding: space(2.5),
  borderBottom: `1px solid ${colors.border}`,
  background: colors.surfaceAlt,
};

const boardInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: `${space(1.5)}px ${space(2.5)}px`,
  fontSize: 13,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  outline: "none",
};

const boardBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: `${space(1.5)}px ${space(3)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const genErrorStyle: CSSProperties = {
  padding: `${space(2)}px ${space(3)}px`,
  fontSize: 12.5,
  color: colors.danger,
  background: "#fdecec",
  borderBottom: `1px solid ${colors.border}`,
};

const metaGridStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: space(6),
  marginBottom: space(4),
};

const pillStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  padding: "3px 10px",
  borderRadius: radius.pill,
  whiteSpace: "nowrap",
};

const statusMenuStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  minWidth: 180,
  maxHeight: 280,
  overflowY: "auto",
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  boxShadow: colors.shadow,
  padding: space(1),
  zIndex: 50,
};

const statusMenuItemStyle: CSSProperties = {
  padding: `${space(1.5)}px ${space(2.5)}px`,
  fontSize: 13,
  color: colors.textMuted,
};

const statusMenuBtnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(1.5),
  width: "100%",
  textAlign: "left",
  border: "none",
  borderRadius: radius.sm,
  padding: `${space(1.5)}px ${space(2.5)}px`,
  fontSize: 13,
  color: colors.text,
  cursor: "pointer",
};

const openBtnStyle: CSSProperties = {
  marginTop: space(6),
  width: "100%",
  padding: `${space(2.5)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const errorStyle: CSSProperties = {
  padding: `${space(2)}px ${space(3)}px`,
  fontSize: 13,
  color: colors.danger,
  background: "#fdecec",
  borderRadius: radius.sm,
  marginBottom: space(3),
};

const lightboxStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.82)",
  display: "flex",
  overflow: "auto",
  zIndex: 60,
  cursor: "zoom-out",
  padding: space(6),
};

const lightboxImgStyle: CSSProperties = {
  margin: "auto", // centers when small, allows scrolling to edges when zoomed
  maxWidth: "92vw",
  maxHeight: "92vh",
  objectFit: "contain",
  borderRadius: radius.sm,
  cursor: "zoom-in",
};

const lightboxImgZoomedStyle: CSSProperties = {
  margin: "auto",
  borderRadius: radius.sm,
  cursor: "zoom-out",
};

const skeletonStyle: CSSProperties = {
  height: 48,
  borderRadius: radius.sm,
  background: `linear-gradient(90deg, ${colors.surfaceAlt}, #e9ecf3, ${colors.surfaceAlt})`,
};
