import { useEffect, useRef, useState, type CSSProperties } from "react";
import { fetchMyTasks, fetchTaskDetail, type ClickUpTask } from "../lib/clickup";
import { isOverdue, relativeDate } from "../lib/format";
import { toMessage } from "../lib/errors";
import { Avatar } from "./Avatar";
import { TaskDrawer } from "./TaskDrawer";
import { colors, radius, space, solidBadgeBg, PRIORITY_COLOR } from "./ui";

type BoardCard = { task: ClickUpTask; x: number; y: number };

const STORE_KEY = "cu-board-cards";
const TASK_MIME = "application/x-cu-task";

function loadCards(): BoardCard[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => c && c.task && typeof c.task.id === "string");
  } catch {
    return [];
  }
}

/** Extract a ClickUp task id from a pasted task URL or a bare id. */
function parseTaskId(input: string): string {
  const s = input.trim();
  const m = s.match(/\/t\/([^/?#]+)/); // https://app.clickup.com/t/<id>
  return (m ? m[1] : s.replace(/^#/, "")).trim();
}

/**
 * A freeform, local-only board of ClickUp task cards. Add cards (pick / paste / drag from the
 * sidebar), drag them around, delete them (board-only — never touches the ClickUp ticket), and
 * click one to open its full ticket. Card positions persist in localStorage.
 */
export function TaskBoard() {
  const [cards, setCards] = useState<BoardCard[]>(() => loadCards());
  const [selected, setSelected] = useState<ClickUpTask | null>(null);
  const [openSeq, setOpenSeq] = useState(0); // bump per open so re-opening a card remounts the drawer
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTasks, setPickerTasks] = useState<ClickUpTask[] | null>(null);
  const [query, setQuery] = useState("");
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const addWrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(cards));
  }, [cards]);

  // Close the add-task picker on Escape or a click outside it.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addWrapRef.current && !addWrapRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  function cascade(): { x: number; y: number } {
    const n = cards.length % 8;
    const scroll = canvasRef.current?.parentElement;
    return { x: 40 + n * 26 + (scroll?.scrollLeft ?? 0), y: 40 + n * 26 + (scroll?.scrollTop ?? 0) };
  }

  function addCard(task: ClickUpTask, x: number, y: number) {
    setCards((cs) => (cs.some((c) => c.task.id === task.id) ? cs : [...cs, { task, x, y }]));
  }
  function removeCard(id: string) {
    setCards((cs) => cs.filter((c) => c.task.id !== id)); // board-only; the ClickUp ticket is untouched
  }

  async function openPicker() {
    setPickerOpen(true);
    if (pickerTasks === null) {
      try {
        setPickerTasks(await fetchMyTasks());
      } catch (e) {
        setError(toMessage(e));
        setPickerTasks([]);
      }
    }
  }

  async function addByPaste() {
    const id = parseTaskId(paste);
    if (!id) return;
    setError(null);
    try {
      const task = await fetchTaskDetail(id);
      const { x, y } = cascade();
      addCard(task, x, y);
      setPaste("");
    } catch {
      setError("Couldn't find that task — check the ClickUp link or id.");
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData(TASK_MIME);
    if (!raw || !canvasRef.current) return;
    try {
      const task = JSON.parse(raw) as ClickUpTask;
      const rect = canvasRef.current.getBoundingClientRect();
      addCard(task, Math.max(0, e.clientX - rect.left - 100), Math.max(0, e.clientY - rect.top - 24));
    } catch {
      /* ignore malformed payloads */
    }
  }

  // Pointer-based move; a press that doesn't move opens the ticket.
  function onCardPointerDown(e: React.PointerEvent, card: BoardCard) {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return; // e.g. the delete button
    drag.current = { id: card.task.id, sx: e.clientX, sy: e.clientY, ox: card.x, oy: card.y, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* element detached / pointer gone — drag still works via the ref */
    }
  }
  function onCardPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return; // tolerance so a click isn't a drag
    d.moved = true;
    setCards((cs) =>
      cs.map((c) => (c.task.id === d.id ? { ...c, x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) } : c)),
    );
  }
  function onCardPointerUp(card: BoardCard) {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      setSelected(card.task); // a click → open the ticket
      setOpenSeq((s) => s + 1);
    }
  }

  const matches =
    pickerTasks?.filter((t) => t.name.toLowerCase().includes(query.toLowerCase())).slice(0, 50) ?? [];

  return (
    <div style={wrapStyle}>
      <div style={toolbarStyle}>
        <strong style={{ fontSize: 13, color: colors.text }}>Task board</strong>
        <div ref={addWrapRef} style={{ position: "relative" }}>
          <button onClick={openPicker} className="primary" style={addBtnStyle}>
            + Add task
          </button>
          {pickerOpen && (
            <div style={pickerStyle}>
              <div style={pickerHeadStyle}>
                <input
                  autoFocus
                  style={pickerSearchStyle}
                  value={query}
                  placeholder="Search your tasks…"
                  onChange={(e) => setQuery(e.currentTarget.value)}
                />
                <button onClick={() => setPickerOpen(false)} title="Close" aria-label="Close" style={pickerCloseStyle}>
                  ✕
                </button>
              </div>
              <div style={{ overflowY: "auto", maxHeight: 260 }}>
                {pickerTasks === null ? (
                  <div style={pickerEmptyStyle}>Loading…</div>
                ) : matches.length === 0 ? (
                  <div style={pickerEmptyStyle}>No matching tasks.</div>
                ) : (
                  matches.map((t) => {
                    const onBoard = cards.some((c) => c.task.id === t.id);
                    return (
                      <button
                        key={t.id}
                        disabled={onBoard}
                        onClick={() => {
                          const { x, y } = cascade();
                          addCard(t, x, y);
                          setPickerOpen(false);
                        }}
                        style={{ ...pickerItemStyle, opacity: onBoard ? 0.45 : 1 }}
                      >
                        <span style={{ ...dotStyle, background: solidBadgeBg(t.statusColor) }} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.name}
                        </span>
                        {onBoard && <span style={{ marginLeft: "auto", fontSize: 11, color: colors.textFaint }}>added</span>}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
        <input
          style={pasteStyle}
          value={paste}
          placeholder="Paste a ClickUp link or id…"
          onChange={(e) => setPaste(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addByPaste();
          }}
        />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: colors.textFaint }}>
          drag tasks from the list · drag cards to arrange · click to open
        </span>
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      <div
        style={scrollStyle}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(TASK_MIME)) e.preventDefault();
        }}
        onDrop={onDrop}
      >
        <div ref={canvasRef} style={canvasStyle}>
          {cards.length === 0 && (
            <div style={emptyStyle}>
              Your board is empty. <strong>+ Add task</strong>, paste a ClickUp link, or drag a task
              from the list on the left.
            </div>
          )}
          {cards.map((card) => (
            <Card
              key={card.task.id}
              card={card}
              onPointerDown={(e) => onCardPointerDown(e, card)}
              onPointerMove={onCardPointerMove}
              onPointerUp={() => onCardPointerUp(card)}
              onCancel={() => {
                drag.current = null; // interrupted/cancelled drag — don't leave a stale ref
              }}
              onDelete={() => removeCard(card.task.id)}
            />
          ))}
        </div>
      </div>

      {selected && (
        <TaskDrawer
          key={`${selected.id}:${openSeq}`}
          task={selected}
          onClose={() => setSelected(null)}
          onTaskUpdated={(u) =>
            setCards((cs) => cs.map((c) => (c.task.id === u.id ? { ...c, task: u } : c)))
          }
        />
      )}
    </div>
  );
}

function Card({
  card,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onCancel,
  onDelete,
}: {
  card: BoardCard;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { task } = card;
  const dueMs = task.dueDate ? Number(task.dueDate) : NaN;
  const hasDue = Number.isFinite(dueMs) && dueMs > 0; // ClickUp can send "0" for a cleared date
  const overdue = hasDue && isOverdue(dueMs, Date.now(), task.statusType);
  const statusBg = solidBadgeBg(task.statusColor);

  return (
    <div
      style={{ ...cardStyle, left: card.x, top: card.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onCancel}
    >
      <button data-no-drag onClick={onDelete} title="Remove from board" aria-label="Remove from board" style={cardDeleteStyle}>
        ✕
      </button>
      <div style={cardTitleStyle}>{task.name}</div>
      <div style={cardMetaStyle}>
        <span style={{ ...cardBadgeStyle, background: statusBg }}>{task.status || "—"}</span>
        {task.priority && (
          <span style={{ color: task.priorityColor || PRIORITY_COLOR[task.priority] || colors.textMuted, fontSize: 11, fontWeight: 600 }}>
            ⚑ {task.priority}
          </span>
        )}
      </div>
      <div style={cardFootStyle}>
        {hasDue && (
          <span style={{ color: overdue ? colors.danger : colors.textMuted, fontSize: 11 }}>
            {relativeDate(dueMs, Date.now())}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {(task.assignees ?? []).slice(0, 3).map((a, i) => (
          <Avatar key={i} name={a.username} color={a.color} init={a.initials} size={20} />
        ))}
      </div>
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
const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  padding: `${space(2.5)}px ${space(4)}px`,
  borderBottom: `1px solid ${colors.border}`,
  background: colors.surface,
};
const addBtnStyle: CSSProperties = {
  padding: `${space(1.5)}px ${space(3)}px`,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const pasteStyle: CSSProperties = {
  width: 240,
  height: 32,
  boxSizing: "border-box",
  padding: `0 ${space(2.5)}px`,
  fontSize: 13,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  outline: "none",
};
const errorStyle: CSSProperties = {
  padding: `${space(2)}px ${space(4)}px`,
  fontSize: 13,
  color: colors.danger,
  background: "#fdecec",
  borderBottom: `1px solid ${colors.border}`,
};
const pickerStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  zIndex: 20,
  width: 340,
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  boxShadow: colors.shadow,
  padding: space(2),
};
const pickerHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  marginBottom: space(2),
};
const pickerSearchStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  padding: `${space(2)}px ${space(2.5)}px`,
  fontSize: 13,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.sm,
  outline: "none",
};
const pickerCloseStyle: CSSProperties = {
  flexShrink: 0,
  width: 30,
  height: 30,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${colors.border}`,
  background: colors.surface,
  borderRadius: radius.sm,
  cursor: "pointer",
  color: colors.textMuted,
};
const pickerItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  width: "100%",
  textAlign: "left",
  border: "none",
  background: "transparent",
  borderRadius: radius.sm,
  padding: `${space(1.5)}px ${space(2)}px`,
  fontSize: 13,
  color: colors.text,
  cursor: "pointer",
};
const pickerEmptyStyle: CSSProperties = {
  padding: space(3),
  fontSize: 13,
  color: colors.textFaint,
};
const dotStyle: CSSProperties = { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 };
const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  position: "relative",
};
const canvasStyle: CSSProperties = {
  position: "relative",
  width: 3000,
  height: 2000,
  // subtle dot grid for a whiteboard feel
  backgroundImage: `radial-gradient(${colors.border} 1px, transparent 1px)`,
  backgroundSize: "22px 22px",
};
const emptyStyle: CSSProperties = {
  position: "absolute",
  top: 60,
  left: 40,
  maxWidth: 360,
  fontSize: 13.5,
  lineHeight: 1.6,
  color: colors.textFaint,
};
const cardStyle: CSSProperties = {
  position: "absolute",
  width: 210,
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: 10,
  boxShadow: "0 1px 3px rgba(20,23,33,0.10)",
  padding: space(2.5),
  cursor: "grab",
  userSelect: "none",
  touchAction: "none",
};
const cardDeleteStyle: CSSProperties = {
  position: "absolute",
  top: 4,
  right: 4,
  width: 20,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  background: "transparent",
  color: colors.textFaint,
  cursor: "pointer",
  borderRadius: radius.sm,
  fontSize: 12,
};
const cardTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: colors.text,
  lineHeight: 1.35,
  marginRight: 16,
  marginBottom: space(2),
  overflow: "hidden",
  textOverflow: "ellipsis",
  display: "-webkit-box",
  WebkitLineClamp: 3,
  WebkitBoxOrient: "vertical",
};
const cardMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  marginBottom: space(2),
  flexWrap: "wrap",
};
const cardBadgeStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  color: "#ffffff",
  padding: "2px 8px",
  borderRadius: radius.pill,
  whiteSpace: "nowrap",
  maxWidth: 150,
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const cardFootStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
};
