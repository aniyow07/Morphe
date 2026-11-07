// Markdown preview: marked for parsing, DOMPurify for safety, and no network access.
import DOMPurify from "dompurify";
import { marked } from "marked";

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  // Remote images would be network requests; show their alt text instead.
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") ?? "";
    if (!src.startsWith("data:")) {
      const alt = document.createElement("span");
      alt.className = "md-img-alt";
      alt.textContent = node.getAttribute("alt") || "image";
      alt.title = src;
      node.replaceWith(alt);
    }
  }
  if (node.tagName === "A") node.setAttribute("title", node.getAttribute("href") ?? "");
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "iframe", "form", "video", "audio", "source", "object", "embed"] });
}
