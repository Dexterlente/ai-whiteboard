import type { ClickUpTask, Comment } from "./clickup";

/**
 * Compact ticket context prepended to a diagram-generation prompt so Claude grounds the
 * flowchart in THIS ticket (title + description + a few comments) instead of guessing from
 * the bare phrase. Description is trimmed to keep the prompt small.
 */
export function buildDiagramContext(
  task: ClickUpTask,
  detail: ClickUpTask | null,
  comments: Comment[],
): string {
  const d = detail ?? task;
  const raw = (d.markdownDescription || d.textDescription || "").trim();
  const description = raw.length > 1500 ? raw.slice(0, 1500) + "…" : raw || "(none)";
  const recent = comments.slice(-5);
  const clip = (t: string) => (t.length > 240 ? t.slice(0, 240) + "…" : t);
  const commentLines = recent.length
    ? recent.map((c) => `  - ${c.author || "Unknown"}: ${clip(c.text || "")}`).join("\n")
    : "  (none)";
  return [
    "TICKET CONTEXT (ground the diagram in this when relevant):",
    `- Title: ${d.name}`,
    "- Description:",
    description,
    `- Recent comments (${recent.length} of ${comments.length}):`,
    commentLines,
  ].join("\n");
}
