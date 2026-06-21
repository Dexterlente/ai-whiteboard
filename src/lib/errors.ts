/** Extract a human-readable message from a thrown value (Tauri rejects with strings). */
export function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
