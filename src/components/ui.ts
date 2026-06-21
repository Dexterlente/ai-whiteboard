// Shared design tokens so the ClickUp panel + drawer stay visually cohesive.

export const colors = {
  bg: "#f7f8fa",
  surface: "#ffffff",
  surfaceAlt: "#f1f3f7",
  border: "#e3e6ec",
  text: "#1f2430",
  textMuted: "#6b7280",
  textFaint: "#9aa1ad",
  accent: "#6366f1", // indigo-500
  danger: "#e5484d",
  shadow: "0 6px 24px rgba(20, 23, 33, 0.12)",
};

export const radius = { sm: 6, pill: 999 };

/** 4px spacing scale: space(2) === 8px. */
export const space = (n: number) => n * 4;

// Deterministic fallback color for statuses/avatars/tags ClickUp didn't color.
const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#e5484d",
  high: "#f5a623",
  normal: "#6390f0",
  low: "#a0a0a0",
};

const DARK_TEXT = "#1f2430";
const LIGHT_TEXT = "#ffffff";

/** Normalize a CSS hex string to 6 lowercase hex digits, or null if it isn't hex. */
function normHex(hex: string | null | undefined): string | null {
  if (!hex) return null;
  let c = hex.trim().replace(/^#/, "");
  if (c.length === 3) c = c.split("").map((x) => x + x).join(""); // f90 → ff9900
  if (c.length === 8) c = c.slice(0, 6); // drop alpha
  return /^[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null;
}

function relLuminance(c: string): number {
  const lin = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio (1..21) between two normalized 6-hex colors. */
function contrast(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Readable text color (dark or white) for a given background color. */
export function readableOn(hex: string | null | undefined): string {
  const c = normHex(hex);
  if (!c) return DARK_TEXT; // unknown / non-hex (named, rgb()) → safe dark on our light surfaces
  return contrast(c, "1f2430") >= contrast(c, "ffffff") ? DARK_TEXT : LIGHT_TEXT;
}

/** Relative luminance (0..1) of an rgb triple. */
function relLumRGB(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Solid badge background from a color — kept vivid, but auto-darkened just enough that
 * WHITE text stays readable (so even a light status/tag color gets legible white labels).
 */
export function solidBadgeBg(hex: string | null | undefined): string {
  const c = normHex(hex);
  if (!c) return colors.textMuted; // neutral fallback for non-hex inputs
  let r = parseInt(c.slice(0, 2), 16);
  let g = parseInt(c.slice(2, 4), 16);
  let b = parseInt(c.slice(4, 6), 16);
  // Scale toward black until white text clears a comfortable ~3.5:1 (luminance ≤ 0.25),
  // since badge text is small (10–11px).
  for (let i = 0; i < 24 && relLumRGB(r, g, b) > 0.25; i++) {
    r = Math.round(r * 0.92);
    g = Math.round(g * 0.92);
    b = Math.round(b * 0.92);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

/** Solid badge colors for a tag: a vivid (auto-darkened) background with white text. */
export function tagColors(tag: { name: string; fg: string | null; bg: string | null }): {
  bg: string;
  fg: string;
} {
  const base = normHex(tag.bg) ? tag.bg! : normHex(tag.fg) ? tag.fg! : colorFor(tag.name);
  return { bg: solidBadgeBg(base), fg: "#ffffff" };
}
