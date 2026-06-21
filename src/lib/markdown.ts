import { marked } from "marked";
import DOMPurify from "dompurify";
import { invoke } from "@tauri-apps/api/core";

// Open links inside rendered markdown in the system browser instead of navigating the whole
// webview away (CSP is open). Capture-phase + stopPropagation so it beats local onClick handlers.
if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as HTMLElement | null)?.closest?.(".cu-markdown a[href]") as
        | HTMLAnchorElement
        | null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        void invoke("open_external", { url: href }).catch(() => {});
      }
    },
    true,
  );
}

/** Render ClickUp markdown to sanitized HTML (safe for dangerouslySetInnerHTML). */
export function renderMarkdown(md: string): string {
  // breaks:true → ClickUp's single newlines become <br>, matching how it displays.
  const raw = marked.parse(md ?? "", { async: false, breaks: true }) as string;
  return DOMPurify.sanitize(raw);
}
