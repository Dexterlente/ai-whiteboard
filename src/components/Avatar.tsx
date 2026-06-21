import { type CSSProperties } from "react";
import { colors, colorFor, readableOn } from "./ui";
import { initials } from "../lib/format";

/** A colored circular avatar with initials, used in task rows and the drawer. */
export function Avatar({
  name,
  color,
  init,
  size = 24,
}: {
  name: string;
  color: string | null;
  init: string | null;
  size?: number;
}) {
  const bg = color || colorFor(name || "?");
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    fontSize: Math.max(9, Math.round(size * 0.42)),
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -4,
    border: `1.5px solid ${colors.surface}`,
    flexShrink: 0,
    background: bg,
    color: readableOn(bg),
  };
  return (
    <span title={name} style={style}>
      {init || initials(name)}
    </span>
  );
}
