// Test-only probe: observes createFileWatcher directly on a disposable fixture.
// Usage: bun rust/recording/watcher_probe.ts <fixture-dir>
import { rename, unlink, writeFile } from "node:fs/promises";
import { createFileWatcher } from "../../src/watch.ts";

const dir = Bun.argv[2];
if (!dir) throw new Error("missing fixture directory");

const events: { type: string; path: string }[] = [];
const watcher = createFileWatcher(dir);
watcher.subscribe((event) => events.push({ ...event }));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await pause(300);
await writeFile(`${dir}/watch-a.md`, "# a\n");
await pause(500);
await rename(`${dir}/watch-a.md`, `${dir}/watch-b.md`);
await pause(500);
await unlink(`${dir}/watch-b.md`);
await pause(500);
watcher.close();
console.log(JSON.stringify(events));
