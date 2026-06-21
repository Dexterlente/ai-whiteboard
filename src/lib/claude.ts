import { invoke } from "@tauri-apps/api/core";

export type DiagramNode = { id: string; text: string; x: number; y: number };
export type DiagramEdge = { from: string; to: string; label?: string };
export type Diagram = { title: string; nodes: DiagramNode[]; edges: DiagramEdge[] };

/** The `claude --output-format json` envelope (only the fields we use). */
type ClaudeEnvelope = { is_error?: boolean; result?: string };

/**
 * Return the brace-balanced substring starting at `from` (skipping anything inside a
 * string literal), or null if the braces never balance before the text ends.
 */
function balancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/**
 * Find the diagram object in the model's reply. The model is told to return bare JSON,
 * but may wrap it in ```json fences or add a preamble that itself contains "{" (e.g.
 * "I used a {decision} node"). So we try each "{" in turn and return the first balanced
 * object that both parses AND has a `nodes` array — ignoring stray braces and non-diagram
 * objects rather than locking onto the first "{" we see.
 */
function parseDiagramObject(text: string): any {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const candidate = balancedObject(text, i);
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && Array.isArray(obj.nodes)) return obj;
    } catch {
      // Not valid JSON starting here — keep scanning for the next "{".
    }
  }
  throw new Error("Claude did not return a diagram JSON object — try rephrasing your prompt");
}

/** Accept a real number or a numeric string; reject null, "", booleans, NaN, etc. */
function coord(value: any, nodeIndex: number, axis: "x" | "y"): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`Claude returned a malformed node (#${nodeIndex + 1}): bad ${axis}`);
}

/**
 * Validate and lightly coerce the parsed object into a Diagram, throwing a clear
 * message if it's unusable. Guarantees no malformed value (missing nodes, NaN
 * coordinates, non-string text, duplicate ids, or self-loops) ever reaches Excalidraw.
 */
function toDiagram(parsed: any): Diagram {
  if (!parsed || !Array.isArray(parsed.nodes)) {
    throw new Error("Claude returned no diagram nodes — try rephrasing your prompt");
  }

  const seen = new Set<string>();
  const nodes: DiagramNode[] = [];
  parsed.nodes.forEach((n: any, i: number) => {
    if (n?.id == null) {
      throw new Error(`Claude returned a malformed node (#${i + 1}): missing id`);
    }
    const id = String(n.id);
    if (seen.has(id)) return; // ignore duplicate ids (keep the first) — check BEFORE validating coords
    const x = coord(n?.x, i, "x");
    const y = coord(n?.y, i, "y");
    seen.add(id);
    nodes.push({ id, text: String(n.text ?? ""), x, y });
  });

  if (nodes.length === 0) {
    throw new Error("Claude returned no diagram nodes — try rephrasing your prompt");
  }

  const edges: DiagramEdge[] = (Array.isArray(parsed.edges) ? parsed.edges : [])
    .filter((e: any) => {
      if (!e) return false;
      const from = String(e.from);
      const to = String(e.to);
      // Skip dangling refs and self-loops (an arrow bound to one box both ends is degenerate).
      return from !== to && seen.has(from) && seen.has(to);
    })
    .map((e: any) => ({
      from: String(e.from),
      to: String(e.to),
      label: e.label ? String(e.label) : undefined,
    }));

  return { title: String(parsed.title ?? ""), nodes, edges };
}

/**
 * Ask Claude (via the local `claude` CLI, run by the Rust backend) for a diagram,
 * then return the parsed and validated result.
 */
export async function generateDiagram(prompt: string): Promise<Diagram> {
  const raw = await invoke<string>("generate_diagram", { prompt });

  const envelope = JSON.parse(raw) as ClaudeEnvelope;
  if (envelope.is_error || envelope.result == null) {
    throw new Error(envelope.result ?? "claude returned no result");
  }

  return toDiagram(parseDiagramObject(envelope.result));
}
