import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import markedFootnote from "marked-footnote";
import { markedHighlight } from "marked-highlight";
import {
  createWikiIndex,
  headingSlug,
  joinRelative,
  matchWikiLink,
  wikiLabel,
  wikiStartRegExp,
  type WikiIndex,
} from "../src/wiki.ts";
import {
  annotateTokenLines,
  splitFrontMatter,
  type LineToken,
} from "./lines.ts";
import { normalizeNewPath } from "./newfile.ts";

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

// Enlaces [[wiki]]: el tokenizador solo deja los datos en el <a>; el destino se
// resuelve después sobre el DOM (`refreshWikiLinks`), porque depende del archivo
// actual y de la lista de archivos, que puede cambiar sin volver a renderizar.
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

marked.use({
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start(src: string) {
        const index = src.indexOf("[[");
        return index < 0 ? undefined : index;
      },
      tokenizer(src: string) {
        const match = wikiStartRegExp().exec(src);
        const ref = match && matchWikiLink(match);
        if (!match || !ref) return undefined;
        return {
          type: "wikilink",
          raw: match[0],
          target: ref.target,
          heading: ref.heading,
          text: wikiLabel(ref),
        };
      },
      renderer(token) {
        return (
          `<a class="wikilink" data-wiki-target="${escapeHtml(String(token.target))}"` +
          ` data-wiki-heading="${escapeHtml(String(token.heading))}">` +
          `${escapeHtml(String(token.text))}</a>`
        );
      },
    },
  ],
});

let wikiIndex: WikiIndex | null = null;

/** Lista de archivos `.md` contra la que se resuelven los enlaces [[wiki]]. */
export function setWikiFiles(files: readonly string[]) {
  wikiIndex = createWikiIndex(files);
}

// Extras de render (config.toml → app.ts). Como las extensiones de marked no se
// pueden desregistrar, la de notas al pie solo se activa una vez.
export interface RenderExtrasOptions {
  footnotes: boolean;
  alerts: boolean;
  frontmatter: boolean;
}

let extras: RenderExtrasOptions = { footnotes: false, alerts: true, frontmatter: true };
let footnotesRegistered = false;

export function setRenderOptions(options: RenderExtrasOptions) {
  extras = options;
  if (options.footnotes && !footnotesRegistered) {
    marked.use(markedFootnote());
    footnotesRegistered = true;
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

export interface RenderOptions {
  /** Las casillas de tarea se pueden marcar. Solo la vista principal; las previews son inertes. */
  interactive?: boolean;
}

export function renderMarkdown(
  source: string,
  path: string,
  options: RenderOptions = {},
): DocumentFragment {
  // Se lexa una sola vez para anotar las líneas antes de renderizar. El hook de
  // marked-highlight también se ejecuta a mano porque no pasamos por `parse`.
  // El front matter se quita solo para el lexer: las líneas se anotan contra el
  // texto original, así que la sincronía con el editor no se desplaza.
  const body = extras.frontmatter ? splitFrontMatter(source) : source;
  const tokens = marked.lexer(body);
  const walk = marked.defaults.walkTokens;
  if (walk) marked.walkTokens(tokens, walk);
  annotateTokenLines(tokens as unknown as LineToken[], source);

  // El contenido de un <template> es inerte: las imágenes no se piden hasta
  // insertarlo, ya con las URLs reescritas.
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(marked.parser(tokens));
  const content = template.content;
  rewriteUrls(content, path);
  refreshWikiLinks(content, path);
  markTaskItems(content, options.interactive === true);
  addHeadingIds(content);
  if (extras.alerts) markAlerts(content);
  return content;
}

/** Título visible de cada alerta de GitHub. */
const ALERT_TITLES = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
} as const;

/**
 * Convierte las citas que empiezan por `> [!NOTE]` en alertas: quita la línea
 * del marcador y marca la cita con su tipo. Debe correr sobre el DOM limpio.
 */
function markAlerts(content: DocumentFragment) {
  for (const quote of content.querySelectorAll("blockquote")) {
    const first = quote.firstElementChild;
    if (!first || first.tagName !== "P") continue;
    const node = first.firstChild;
    const match = node?.nodeType === Node.TEXT_NODE &&
      /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i.exec(node.nodeValue ?? "");
    if (!match) continue;

    node.nodeValue = node.nodeValue!.slice(match[0].length);
    if (!first.textContent?.trim()) first.remove();
    const type = match[1]!.toLowerCase() as keyof typeof ALERT_TITLES;
    quote.classList.add("alert", `alert-${type}`);
    quote.dataset.alert = ALERT_TITLES[type];
  }
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

/** Archivo que se crearía al pulsar un enlace [[wiki]] roto, junto al documento actual. */
function newWikiPath(target: string, from: string) {
  const name = target.trim().replace(/\\/g, "/");
  const rooted = name.startsWith("/");
  const relative = /^\.{1,2}\//.test(name);
  // Un nombre suelto (o `./`, `../`) cuelga de la carpeta del documento; una ruta
  // con carpetas (`a/b`) o con `/` inicial, de la raíz.
  const fromRoot = rooted || (name.includes("/") && !relative);
  const base = fromRoot ? "" : from.slice(0, from.lastIndexOf("/") + 1);
  const joined = joinRelative(base, rooted ? name.slice(1) : name);
  return joined ? normalizeNewPath(joined) : null;
}

/**
 * Resuelve los enlaces [[wiki]] de `root`: apuntan a su archivo, o se marcan como
 * rotos y ofrecen crearlo. Se puede repetir sobre el mismo DOM (la lista de
 * archivos cambió) sin volver a renderizar. Sin lista aún, se dejan sin destino.
 */
export function refreshWikiLinks(root: ParentNode, path: string) {
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a.wikilink")) {
    link.classList.remove("missing");
    link.removeAttribute("href");
    link.removeAttribute("title");
    delete link.dataset.wikiCreate;
    if (!wikiIndex) continue;

    const target = link.dataset.wikiTarget ?? "";
    const heading = link.dataset.wikiHeading ?? "";
    const hash = heading ? `#${encodeURIComponent(headingSlug(heading))}` : "";
    const resolved = wikiIndex.resolve(target, path);

    if (resolved) {
      link.href = viewUrl(resolved) + hash;
      link.title = resolved;
      continue;
    }

    link.classList.add("missing");
    const create = newWikiPath(target, path);
    if (!create) continue;
    link.href = viewUrl(create);
    link.dataset.wikiCreate = create;
    link.title = `Create ${create}`;
  }
}

function markTaskItems(content: DocumentFragment, interactive: boolean) {
  for (const box of content.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]')) {
    box.closest("li")?.classList.add("task");
    if (!interactive) continue;
    box.removeAttribute("disabled");
    // Fuera del orden de tabulación: un clic no debe dejar el foco en la casilla,
    // porque con el foco en un <input> las teclas de la vista (j, k, x…) se ignoran.
    box.tabIndex = -1;
  }
}

function addHeadingIds(content: DocumentFragment) {
  const used = new Set(Array.from(content.querySelectorAll("[id]"), (el) => el.id));

  for (const heading of content.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (heading.id) continue;
    const slug = headingSlug(heading.textContent ?? "");
    if (!slug) continue;

    let id = slug;
    for (let n = 1; used.has(id); n++) id = `${slug}-${n}`;
    used.add(id);
    heading.id = id;
  }
}
