// Graba la salida de search/backlinks originales sobre rust/search/cases.json.
// Uso: bun rust/recording/search_probe.ts > rust/search/baseline.json
import { buildHit, searchText } from "../../src/search.ts";
import {
  extractLinks,
  findBacklinks,
  markdownTarget,
} from "../../src/backlinks.ts";
import { createWikiIndex } from "../../src/wiki.ts";

type Args = any[];
const dispatch: Record<string, (...args: Args) => unknown> = {
  searchText: (path: string, text: string, query: string, perFile: number) =>
    searchText(path, text, query, perFile),
  buildHit: (path: string, line: number, raw: string, ranges: [number, number][]) =>
    buildHit(path, line, raw, ranges),
  extractLinks: (source: string) => extractLinks(source),
  markdownTarget: (destination: string, from: string) => markdownTarget(destination, from),
  findBacklinks: (
    files: string[],
    source: string,
    from: string,
    to: string,
    perFile: number,
  ) => findBacklinks(source, from, to, createWikiIndex(files), perFile),
};

const cases = JSON.parse(await Bun.file("rust/search/cases.json").text());
const results = cases.cases.map((entry: { id: string; fn: string; args: Args }) => {
  const run = dispatch[entry.fn];
  if (!run) throw new Error(`unknown function: ${entry.fn}`);
  return { id: entry.id, fn: entry.fn, args: entry.args, output: run(...entry.args) };
});
console.log(
  JSON.stringify(
    { schema: "markvi-search-baseline@1", generated_by: "rust/recording/search_probe.ts", bun: Bun.version, cases: results },
    null,
    2,
  ),
);
