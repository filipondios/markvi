import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import markedFootnote from "marked-footnote";
import { markedHighlight } from "marked-highlight";
import {
  FILES_PREFIX,
  VIEW_PREFIX,
  normalizeNewPath,
  viewUrl,
} from "./shared/paths.ts";
import {
  createWikiIndex,
  headingSlug,
  joinRelative,
  matchWikiLink,
  wikiLabel,
  wikiStartRegExp,
  type WikiIndex,
} from "./shared/wiki.ts";
import {
  annotateTokenLines,
  splitFrontMatter,
  type LineToken,
} from "./lines.ts";
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

// --- Política de sanitizado ---------------------------------------------------
// El HTML de un `.md` ajeno no debe poder cambiar el aspecto de la aplicación
// (`<style>`, estilos en línea de posición fija) ni pedir datos al usuario
// (`<form>` y campos): sería phishing dentro de una página de confianza.
// Las casillas de tareas (`<input type="checkbox">`) sí se conservan.
const FORBID_TAGS = ["style", "form", "button", "select", "option", "textarea", "fieldset"];

// Estilos en línea que cargan recursos, superponen contenido o ejecutan código.
const RISKY_STYLE = /url\s*\(|@import|expression\s*\(|position\s*:\s*(?:fixed|sticky|absolute)/i;

DOMPurify.addHook("uponSanitizeElement", (node) => {
  if (node.nodeName !== "INPUT") return;
  const type = (node as Element).getAttribute("type")?.toLowerCase();
  if (type !== "checkbox") node.parentNode?.removeChild(node);
});

DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "style" && RISKY_STYLE.test(data.attrValue)) data.keepAttr = false;
});

const SANITIZE_CONFIG = {
  RETURN_DOM_FRAGMENT: true as const,
  FORBID_TAGS,
};

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
  remoteimages: boolean;
}

let extras: RenderExtrasOptions = {
  footnotes: false,
  alerts: true,
  frontmatter: true,
  remoteimages: false,
};
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
  annotateTokenLines(tokens as unknown as LineToken[], source, source.length - body.length);

  // El contenido de un <template> es inerte: las imágenes no se piden hasta
  // insertarlo, ya con las URLs reescritas. DOMPurify devuelve el DOM ya limpio (en
  // el documento inerte del DOMParser) y se adopta tal cual: evita serializarlo a
  // texto y volver a parsearlo (−40 % en sanitizado+parseo con un documento de
  // 400 KB), y además descarta la ida y vuelta por texto de la que se aprovechan los
  // ataques de mutación (mXSS).
  const template = document.createElement("template");
  template.content.append(
    DOMPurify.sanitize(marked.parser(tokens), SANITIZE_CONFIG),
  );
  const content = template.content;
  if (!extras.remoteimages) blockRemoteResources(content, path);
  rewriteUrls(content, path);
  refreshWikiLinks(content, path);
  markTaskItems(content, options.interactive === true);
  addHeadingIds(content);
  if (extras.alerts) markAlerts(content);
  markCodeBlocks(content);
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

// Elementos que el navegador carga solo al insertarlos (sin que el usuario pulse
// nada). Los enlaces `<a>` no se tocan: solo se siguen al hacer clic.
const AUTO_LOADED = "img, source, video, audio, track, image, use";
const RESOURCE_ATTRS = ["src", "poster", "href", "xlink:href"] as const;

function isRemote(value: string, base: URL) {
  const url = resolveUrl(value.trim(), base);
  return url !== null && /^https?:$/.test(url.protocol) && url.origin !== location.origin;
}

/**
 * Quita las referencias a otros sitios de los recursos que se cargan solos. La
 * imagen queda marcada (`remote-blocked`) con su texto alternativo y el origen
 * bloqueado en el título.
 */
function blockRemoteResources(content: DocumentFragment, path: string) {
  const base = new URL(viewUrl(path), location.origin);

  for (const el of content.querySelectorAll(AUTO_LOADED)) {
    let blocked: string | null = null;

    for (const attr of RESOURCE_ATTRS) {
      const value = el.getAttribute(attr);
      if (value !== null && isRemote(value, base)) {
        blocked ??= value;
        el.removeAttribute(attr);
      }
    }

    // `srcset` es una lista `url [descriptor], url …`: basta una remota para quitarla.
    const srcset = el.getAttribute("srcset");
    if (srcset !== null && srcset.split(",").some((entry) => isRemote(entry.trim().split(/\s+/)[0] ?? "", base))) {
      blocked ??= srcset;
      el.removeAttribute("srcset");
    }

    if (blocked === null) continue;
    el.classList.add("remote-blocked");
    el.setAttribute("title", `Remote content blocked: ${blocked}`);
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



/** Añade una cabecera editorial a cada bloque de código con el lenguaje detectado. */
function markCodeBlocks(content: DocumentFragment) {
  for (const pre of content.querySelectorAll<HTMLPreElement>("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const languageClass = Array.from(code.classList).find((name) => name.startsWith("language-"));
    const language = languageClass?.slice("language-".length) || "text";
    pre.classList.add("code-block");
    pre.dataset.language = language.toUpperCase();
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
