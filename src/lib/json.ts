/**
 * Return the brace-balanced substring starting at `from` (skipping anything inside a
 * string literal), or null if the braces never balance before the text ends.
 */
export function balancedObject(text: string, from: number): string | null {
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
 * Find the first balanced {...} object in `text` that JSON-parses AND satisfies `accept`.
 * The model is told to return bare JSON, but may wrap it in ```json fences or add a
 * preamble that itself contains "{". So we try each "{" in turn and return the first
 * object that parses and passes `accept` — ignoring stray braces and non-matching objects.
 * Returns the parsed object, or null if none qualifies.
 */
export function findJsonObject(text: string, accept: (o: any) => boolean): any | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const candidate = balancedObject(text, i);
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && accept(obj)) return obj;
    } catch {
      // Not valid JSON starting here — keep scanning for the next "{".
    }
  }
  return null;
}
