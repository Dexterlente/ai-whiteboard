import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { Diagram } from "./claude";

const BOX_W = 170;
const BOX_H = 60;

/**
 * Point where the ray from box center (cx,cy) toward (tx,ty) exits a box of half-width hw,
 * half-height hh. Lets arrows touch the box border cleanly from any direction (top-down
 * flowcharts and radial mind maps alike).
 */
function borderPoint(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number) {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  // Scale the direction so it just reaches the nearest edge (rectangle ray-cast).
  const scale = Math.min(
    dx === 0 ? Infinity : hw / Math.abs(dx),
    dy === 0 ? Infinity : hh / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * Convert our simple { nodes, edges } diagram into real Excalidraw elements.
 * Boxes use the friendly "skeleton" shorthand; arrows get EXPLICIT geometry because
 * convertToExcalidrawElements only attaches binding metadata for id-bound arrows — it never
 * routes their points between the boxes, so without explicit points every arrow collapses to
 * the canvas origin. After conversion we re-clip each arrow to the ACTUAL box bounds, since
 * Excalidraw grows a labeled box to fit wrapped text (the fixed BOX_W/BOX_H is only an estimate).
 */
export function diagramToElements(diagram: Diagram) {
  // The skeleton format is loosely typed by Excalidraw; `any[]` keeps it readable here.
  const skeleton: any[] = [];
  const pos = new Map<string, { x: number; y: number }>();

  for (const node of diagram.nodes) {
    pos.set(node.id, { x: node.x, y: node.y });
    skeleton.push({
      type: "rectangle",
      id: node.id, // edges reference this id; convertToExcalidrawElements remaps it for the binding
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

    // Estimate the border-to-border line using the nominal box size; refined below.
    const fc = { x: from.x + BOX_W / 2, y: from.y + BOX_H / 2 };
    const tc = { x: to.x + BOX_W / 2, y: to.y + BOX_H / 2 };
    const start = borderPoint(fc.x, fc.y, BOX_W / 2, BOX_H / 2, tc.x, tc.y);
    const end = borderPoint(tc.x, tc.y, BOX_W / 2, BOX_H / 2, fc.x, fc.y);
    if (start.x === end.x && start.y === end.y) continue; // boxes share a position → no visible arrow

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
      start: { id: edge.from },
      end: { id: edge.to },
      ...(edge.label ? { label: { text: edge.label } } : {}),
    });
  }

  const elements = convertToExcalidrawElements(skeleton);

  // Re-clip arrows to the real (post-layout) box bounds so endpoints sit on the actual border
  // even when a label wrapped and grew its box past the BOX_W/BOX_H estimate.
  const boxes = new Map<string, any>();
  for (const el of elements as any[]) if (el.type === "rectangle") boxes.set(el.id, el);

  return (elements as any[]).map((el) => {
    if (el.type !== "arrow") return el;
    const a = boxes.get(el.startBinding?.elementId);
    const b = boxes.get(el.endBinding?.elementId);
    if (!a || !b) return el;
    const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const s = borderPoint(ac.x, ac.y, a.width / 2, a.height / 2, bc.x, bc.y);
    const e = borderPoint(bc.x, bc.y, b.width / 2, b.height / 2, ac.x, ac.y);
    if (s.x === e.x && s.y === e.y) return el;
    return {
      ...el,
      x: s.x,
      y: s.y,
      points: [
        [0, 0],
        [e.x - s.x, e.y - s.y],
      ],
      width: Math.abs(e.x - s.x),
      height: Math.abs(e.y - s.y),
    };
  });
}
