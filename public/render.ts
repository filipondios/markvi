import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import { annotateTokenLines, type LineToken } from "./lines.ts";

export const VIEW_PREFIX = "/view/";
const FILES_PREFIX = "/files/";

export const viewUrl = (path: string) =>
  VIEW_PREFIX + path.split("/").map(encodeURIComponent).join("/");

const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  }),
);

// Los atributos de línea se añaden al HTML de cada bloque. DOMPurify los
// conserva por ser `data-*`.
const blockRenderers = [
  "heading",
  "paragraph",
  "list",
  "listitem",
  "blockquote",
  "code",
  "table",
  "hr",
] as const;
const renderer = marked.defaults.renderer;
if (renderer) {
  const methods = renderer as unknown as Record<
    string,
    (token: LineToken, ...args: unknown[]) => string
  >;
  for (const name of blockRenderers) {
    const original = methods[name];
    if (typeof original !== "function") continue;
    methods[name] = function (this: unknown, token: LineToken, ...args: unknown[]) {
      return addLineAttributes(original.call(this, token, ...args), token);
    };
  }
}

function addLineAttributes(html: string, token: LineToken): string {
  if (token.line === undefined) return html;
  const endLine = token.endLine ?? token.line;
  return html.replace(
    /^<([a-zA-Z][\w-]*)/,
    `<$1 data-line="${token.line}" data-end-line="${endLine}"`,
  );
}

export function renderMarkdown(source: string, path: string): DocumentFragment {
  // Se lexa una sola vez para anotar las líneas antes de renderizar. El hook de
  // marked-highlight también se ejecuta a mano porque no pasamos por `parse`.
  const tokens = marked.lexer(source);
  const walk = marked.defaults.walkTokens;
  if (walk) marked.walkTokens(tokens, walk);
  annotateTokenLines(tokens as unknown as LineToken[], source);

  // El contenido de un <template> es inerte: las imágenes no se piden hasta
  // insertarlo, ya con las URLs reescritas.
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(marked.parser(tokens));
  const content = template.content;
  rewriteUrls(content, path);
  markTaskItems(content);
  addHeadingIds(content);
  return content;
}

function resolveUrl(value: string, base: URL) {
  // Una ruta absoluta (`/img/a.png`) se interpreta desde el directorio raíz.
  const fromRoot = value.startsWith("/") && !value.startsWith("//");
  try {
    return fromRoot ? new URL(`.${value}`, new URL(VIEW_PREFIX, base)) : new URL(value, base);
  } catch {
    return null;
  }
}

function rewriteUrls(content: DocumentFragment, path: string) {
  const base = new URL(viewUrl(path), location.origin);

  for (const el of content.querySelectorAll("[href], [src]")) {
    const attr = el.hasAttribute("href") ? "href" : "src";
    const url = resolveUrl(el.getAttribute(attr) ?? "", base);
    if (!url) continue;

    const isLink = el.tagName === "A";
    if (url.origin !== location.origin) {
      if (isLink && /^https?:$/.test(url.protocol)) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
      continue;
    }
    if (!url.pathname.startsWith(VIEW_PREFIX)) continue;

    const rest = url.pathname.slice(VIEW_PREFIX.length);
    const prefix = isLink && /\.md$/i.test(rest) ? VIEW_PREFIX : FILES_PREFIX;
    el.setAttribute(attr, prefix + rest + url.search + url.hash);
  }
}

function markTaskItems(content: DocumentFragment) {
  for (const box of content.querySelectorAll('li input[type="checkbox"]')) {
    box.closest("li")?.classList.add("task");
  }
}

function addHeadingIds(content: DocumentFragment) {
  const used = new Set(Array.from(content.querySelectorAll("[id]"), (el) => el.id));

  for (const heading of content.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (heading.id) continue;
    const slug = (heading.textContent ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-");
    if (!slug) continue;

    let id = slug;
    for (let n = 1; used.has(id); n++) id = `${slug}-${n}`;
    used.add(id);
    heading.id = id;
  }
}
