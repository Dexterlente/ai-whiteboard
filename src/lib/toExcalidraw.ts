import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { Diagram } from "./claude";

const BOX_W = 170;
const BOX_H = 60;

/**
 * Intersection of the ray from a box center toward (tx, ty) with that box's border.
 * Returns the point on the rectangle edge, so arrows touch the box cleanly from any
 * direction (works for top-down flowcharts and radial mind maps alike).
 */
function borderPoint(cx: number, cy: number, tx: number, ty: number) {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = BOX_W / 2;
  const hh = BOX_H / 2;
  // Scale the direction so it just reaches the nearest edge (rectangle ray-cast).
  const scale = Math.min(
    dx === 0 ? Infinity : hw / Math.abs(dx),
    dy === 0 ? Infinity : hh / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * Convert our simple { nodes, edges } diagram into real Excalidraw elements.
 * Boxes use the friendly "skeleton" shorthand; arrows get EXPLICIT geometry computed
 * from the node coordinates (border-to-border) because convertToExcalidrawElements only
 * attaches binding metadata for id-bound arrows — it never routes their points between
 * the boxes, so without explicit points every arrow collapses to the canvas origin.
 */
let batchSeq = 0;

export function diagramToElements(diagram: Diagram) {
  // The skeleton format is loosely typed by Excalidraw; `any[]` keeps it readable here.
  const skeleton: any[] = [];
  const pos = new Map<string, { x: number; y: number }>();

  // Namespace this batch's ids so a second generation (or a reopened board that already
  // contains "n1", "n2"…) never collides with these — collisions make elements vanish or overwrite.
  const prefix = `d${Date.now().toString(36)}-${batchSeq++}-`;
  const nid = (id: string) => prefix + id;

  for (const node of diagram.nodes) {
    pos.set(node.id, { x: node.x, y: node.y });
    skeleton.push({
      type: "rectangle",
      id: nid(node.id), // same id the edges reference → lets arrows bind to this box
      x: node.x,
      y: node.y,
      width: BOX_W,
      height: BOX_H,
      label: { text: node.text },
    });
  }

  for (const edge of diagram.edges) {
    const from = pos.get(edge.from);
    const to = pos.get(edge.to);
    if (!from || !to) continue; // dangling ref (shouldn't happen — already filtered upstream)

    // Centers of the two boxes, then clip the connecting line to each box's border.
    const fc = { x: from.x + BOX_W / 2, y: from.y + BOX_H / 2 };
    const tc = { x: to.x + BOX_W / 2, y: to.y + BOX_H / 2 };
    const start = borderPoint(fc.x, fc.y, tc.x, tc.y);
    const end = borderPoint(tc.x, tc.y, fc.x, fc.y);
    if (start.x === end.x && start.y === end.y) continue; // boxes share a position → no visible arrow to draw

    skeleton.push({
      type: "arrow",
      x: start.x,
      y: start.y,
      // Points are relative to (x, y); this is what actually makes the arrow visible.
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
      endArrowhead: "arrow",
      // Keep the bindings so arrows still follow when the user drags a box.
      start: { id: nid(edge.from) },
      end: { id: nid(edge.to) },
      ...(edge.label ? { label: { text: edge.label } } : {}),
    });
  }

  return convertToExcalidrawElements(skeleton);
}
