import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { Diagram } from "./claude";

const BOX_W = 170;
const BOX_H = 60;

/**
 * Convert our simple { nodes, edges } diagram into real Excalidraw elements.
 * We build "element skeletons" (the friendly shorthand) and let Excalidraw's
 * convertToExcalidrawElements fill in all the required low-level fields.
 */
export function diagramToElements(diagram: Diagram) {
  // The skeleton format is loosely typed by Excalidraw; `any[]` keeps it readable here.
  const skeleton: any[] = [];

  for (const node of diagram.nodes) {
    skeleton.push({
      type: "rectangle",
      id: node.id, // same id the edges reference → lets arrows bind to this box
      x: node.x,
      y: node.y,
      width: BOX_W,
      height: BOX_H,
      label: { text: node.text },
    });
  }

  for (const edge of diagram.edges) {
    skeleton.push({
      type: "arrow",
      x: 0, // required by the API but ignored once start/end bindings resolve
      y: 0,
      start: { id: edge.from },
      end: { id: edge.to },
      ...(edge.label ? { label: { text: edge.label } } : {}),
    });
  }

  return convertToExcalidrawElements(skeleton);
}
