// Graba la salida de las funciones puras originales sobre rust/core/cases.json.
// Uso: bun rust/recording/core_probe.ts > rust/core/baseline.json
import { isCaseSensitive } from "../../src/case.ts";
import { defaultConfig } from "../../src/configdefaults.ts";
import * as paths from "../../src/paths.ts";
import * as wiki from "../../src/wiki.ts";

type Args = unknown[];
const dispatch: Record<string, (...args: Args) => unknown> = {
  isCaseSensitive: (q: string) => isCaseSensitive(q),
  normalizePath: (p: string) => paths.normalizePath(p),
  isMarkdownPath: (p: string) => paths.isMarkdownPath(p),
  isSafePath: (p: string) => paths.isSafePath(p),
  normalizeNewPath: (p: string) => paths.normalizeNewPath(p),
  splitPath: (p: string) => paths.splitPath(p),
  viewUrl: (p: string) => paths.viewUrl(p),
  fileUrl: (p: string) => paths.fileUrl(p),
  encodeURIComponent: (s: string) => encodeURIComponent(s),
  defaultConfig: () => defaultConfig(),
  parseWikiLink: (inner: string) => {
    const match = `[[${inner}]]`.match(wiki.wikiStartRegExp());
    return match ? wiki.matchWikiLink(match) : null;
  },
  wikiLinks: (text: string) => {
    const re = wiki.wikiGlobalRegExp();
    const out: [number, string][] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) out.push([match.index, match[0]]);
    return out;
  },
  wikiLabel: (ref: wiki.WikiRef) => wiki.wikiLabel(ref),
  headingSlug: (text: string) => wiki.headingSlug(text),
  joinRelative: (base: string, rel: string) => wiki.joinRelative(base, rel),
  resolve: (files: string[], target: string, from: string) =>
    wiki.createWikiIndex(files).resolve(target, from),
};

const cases = JSON.parse(await Bun.file("rust/core/cases.json").text());
const results = cases.cases.map((entry: { id: string; fn: string; args: Args }) => {
  const run = dispatch[entry.fn];
  if (!run) throw new Error(`unknown function: ${entry.fn}`);
  return { id: entry.id, fn: entry.fn, args: entry.args, output: run(...entry.args) };
});
console.log(
  JSON.stringify(
    {
      schema: "markvi-core-baseline@1",
      generated_by: "rust/recording/core_probe.ts",
      bun: Bun.version,
      cases: results,
    },
    null,
    2,
  ),
);
