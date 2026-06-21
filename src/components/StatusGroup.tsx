import { useState, type CSSProperties } from "react";
import type { StatusGroup as StatusGroupT } from "../lib/format";
import type { ClickUpTask } from "../lib/clickup";
import { TaskRow } from "./TaskRow";
import { colors, colorFor, radius, space } from "./ui";

/** A collapsible section of tasks sharing one status. */
export function StatusGroup({
  group,
  defaultOpen,
  onOpen,
}: {
  group: StatusGroupT;
  defaultOpen: boolean;
  onOpen: (t: ClickUpTask) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const dot = group.color || colorFor(group.status);

  return (
    <div style={{ marginBottom: space(1) }}>
      <button onClick={() => setOpen((o) => !o)} style={headerStyle}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 12,
            flexShrink: 0,
            transition: "transform 0.15s",
            transformOrigin: "center",
            transform: open ? "rotate(90deg)" : "none",
            color: colors.textFaint,
            fontSize: 10,
          }}
        >
          ▶
        </span>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: dot, flexShrink: 0 }} />
        <span style={labelStyle}>{group.status}</span>
        <span style={countStyle}>{group.tasks.length}</span>
      </button>
      {open && group.tasks.map((t) => <TaskRow key={t.id} task={t} onOpen={onOpen} />)}
    </div>
  );
}

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  width: "100%",
  padding: `${space(2)}px ${space(3)}px`,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  borderRadius: radius.sm,
};

const labelStyle: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: colors.textMuted,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const countStyle: CSSProperties = {
  marginLeft: "auto",
  fontSize: 11,
  fontWeight: 600,
  color: colors.textMuted,
  background: colors.surfaceAlt,
  borderRadius: radius.pill,
  padding: "1px 8px",
  minWidth: 20,
  textAlign: "center",
};
