import { useState, type CSSProperties } from "react";
import type { ClickUpTask } from "../lib/clickup";
import { isOverdue, relativeDate } from "../lib/format";
import { Avatar } from "./Avatar";
import { colors, radius, space, PRIORITY_COLOR, tagColors } from "./ui";

/** A single, pretty task row: title + priority/due/assignees + tags. */
export function TaskRow({
  task,
  onOpen,
}: {
  task: ClickUpTask;
  onOpen: (t: ClickUpTask) => void;
}) {
  const [hover, setHover] = useState(false);
  const now = Date.now();
  const dueMs = task.dueDate ? Number(task.dueDate) : NaN;
  const hasDue = Number.isFinite(dueMs) && dueMs > 0; // ClickUp can send "0" for a cleared date
  const overdue = hasDue && isOverdue(dueMs, now, task.statusType);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        // Lets the task be dropped onto the board (TaskBoard reads this payload).
        e.dataTransfer.setData("application/x-cu-task", JSON.stringify(task));
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onOpen(task)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(task);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...rowStyle, background: hover ? colors.surfaceAlt : "transparent" }}
    >
      <div style={titleStyle}>{task.name}</div>

      <div style={metaStyle}>
        {task.priority && (
          <span
            style={{
              color: task.priorityColor || PRIORITY_COLOR[task.priority] || colors.textMuted,
              fontWeight: 600,
            }}
          >
            ⚑ {task.priority}
          </span>
        )}
        {hasDue && (
          <span style={{ color: overdue ? colors.danger : colors.textMuted, fontWeight: overdue ? 600 : 400 }}>
            {relativeDate(dueMs, now)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {task.assignees.slice(0, 3).map((a, i) => (
          <Avatar key={i} name={a.username} color={a.color} init={a.initials} size={20} />
        ))}
      </div>

      {task.tags.length > 0 && (
        <div style={tagsRowStyle}>
          {task.tags.slice(0, 4).map((tg, i) => {
            const { bg, fg } = tagColors(tg);
            return (
              <span key={`${tg.name}-${i}`} style={{ ...tagPillStyle, background: bg, color: fg }}>
                {tg.name}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space(1.5),
  padding: `${space(2.5)}px ${space(3)}px ${space(2.5)}px ${space(6)}px`,
  cursor: "pointer",
  borderRadius: radius.sm,
  transition: "background 0.12s",
  outline: "none",
};

const titleStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 500,
  color: colors.text,
  lineHeight: 1.35,
  overflow: "hidden",
  textOverflow: "ellipsis",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
};

const metaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  fontSize: 11.5,
  color: colors.textMuted,
};

const tagsRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: space(1),
};

const tagPillStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: "1px 7px",
  borderRadius: radius.pill,
  letterSpacing: 0.2,
};
