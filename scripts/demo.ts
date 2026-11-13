/**
 * Generates README screenshots and the demo GIF directly from 
 * a live instance of the application.
 *
 * Usage:
 *   bun run demo # Generate both screenshots and GIF
 *   bun run demo --only shots # Generate screenshots only
 *   bun run demo --only gif --theme dark
 *   bun run demo --out docs --video raw.webm
 *
 * Execution runs against an isolated temporary copy of `example/` with an empty
 * configuration file, ensuring `~/.config/markvi` and the repository remain untouched.
 *
 * Prerequisites (excluded from runtime app dependencies):
 *   bun add -d playwright && bunx playwright install chromium
 *   ffmpeg available in PATH (required only for GIF encoding)
 */

import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GIF_CONFIG = {
  width: 1000,
  height: 620,
  outWidth: 800,
  fps: 10,
  colors: 96,
} as const;

const SHOT_VIEWPORT = {
  width: 1100,
  height: 720,
  deviceScaleFactor: 2,
} as const;

const KEY_OVERLAY_SCRIPT = String.raw`
(() => {
  const KEY_LABELS = {
    " ": "space",
    Escape: "Esc",
    Enter: "Enter",
    Backspace: "⌫",
    Tab: "Tab",
    ArrowDown: "↓",
    ArrowUp: "↑",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  let container, clearTimer;

  const mount = () => {
    const style = document.createElement("style");
    style.textContent = ` + "`" + String.raw`
      #demo-keys {
        position: fixed;
        left: 50%;
        bottom: 56px;
        z-index: 99999;
        display: flex;
        gap: 7px;
        transform: translateX(-50%);
        pointer-events: none;
      }
      #demo-keys kbd {
        padding: 8px 13px;
        color: #fff;
        font: 600 15px/1 var(--font-mono, ui-monospace, monospace);
        background: rgba(22, 27, 34, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 8px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        animation: demo-key-in 90ms ease-out;
      }
      @keyframes demo-key-in {
        from { transform: translateY(5px) scale(0.94); opacity: 0; }
      }
    ` + "`" + String.raw`;
    document.head.append(style);
    container = document.createElement("div");
    container.id = "demo-keys";
    document.body.append(container);
  };

  const pushKey = (label) => {
    if (!container) mount();
    const badge = document.createElement("kbd");
    badge.textContent = label;
    container.append(badge);
    while (container.children.length > 5) container.firstElementChild.remove();
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => container.replaceChildren(), 1300);
  };

  window.addEventListener("keydown", (event) => {
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    const mode = (document.querySelector("#status-mode")?.textContent ?? "").trim().toLowerCase();
    const isPrintable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    const isSearching = event.target instanceof HTMLInputElement && event.target.type === "search";

    if (isPrintable && (mode === "insert" || mode === "replace" || isSearching)) return;

    const label = KEY_LABELS[event.key] ?? event.key;
    pushKey(event.ctrlKey ? "Ctrl-" + label : label);
  }, true);
})();
`;

function fail(message: string): never {
  console.error(`demo: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const getOption = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const only = getOption("only");
  if (only !== undefined && only !== "shots" && only !== "gif") {
    fail('--only must be "shots" or "gif"');
  }

  return {
    theme: (getOption("theme") === "dark" ? "dark" : "light") as "light" | "dark",
    outDir: resolve(ROOT_DIR, getOption("out") ?? "gen"),
    keepVideoPath: getOption("video"),
    doShots: only === undefined || only === "shots",
    doGif: only === undefined || only === "gif",
  };
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    fail("Playwright is not installed. Run: bun add -d playwright && bunx playwright install chromium");
  }
}

type PlaywrightModule = Awaited<ReturnType<typeof loadPlaywright>>;
type Browser = Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

async function findFreePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

async function withApp<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const workDir = await mkdtemp(join(tmpdir(), "markvi-demo-"));
  const vaultDir = join(workDir, "notes");
  await cp(join(ROOT_DIR, "example"), vaultDir, { recursive: true });

  const port = await findFreePort();
  const server = Bun.spawn(
    ["bun", "run", "server.ts", vaultDir, "--port", String(port), "--config", join(workDir, "none.toml")],
    { cwd: ROOT_DIR, stdout: "ignore", stderr: "inherit" },
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await fetch(`${baseUrl}/api/tree`)).ok) break;
      } catch {
        // Server not ready yet.
      }
      if (attempt > 100) fail("Timed out waiting for the application server to start");
      await Bun.sleep(100);
    }
    return await run(baseUrl);
  } finally {
    server.kill();
    await rm(workDir, { recursive: true, force: true });
  }
}

function createKeyboardHelper(page: Page) {
  return {
    async press(key: string, waitMs = 450) {
      await page.keyboard.press(key);
      await page.waitForTimeout(waitMs);
    },
    async type(text: string, waitMs = 400, delayMs = 65) {
      await page.keyboard.type(text, { delay: delayMs });
      await page.waitForTimeout(waitMs);
    },
    async leader(nextKey: string, panelDelayMs = 0, waitMs = 450) {
      await page.keyboard.press(" ");
      await page.waitForTimeout(panelDelayMs);
      await page.keyboard.press(nextKey);
      await page.waitForTimeout(waitMs);
    },
  };
}

async function openDocument(page: Page, baseUrl: string, docPath: string) {
  await page.goto(`${baseUrl}/view/${docPath}`);
  await page.waitForSelector("#content h1");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

async function captureScreenshots(baseUrl: string, browser: Browser, outDir: string) {
  const screenshotsDir = join(outDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  const capture = async (
    filename: string,
    colorScheme: "light" | "dark",
    setup: (page: Page) => Promise<void>,
  ) => {
    const context = await browser.newContext({
      viewport: { width: SHOT_VIEWPORT.width, height: SHOT_VIEWPORT.height },
      deviceScaleFactor: SHOT_VIEWPORT.deviceScaleFactor,
      colorScheme,
    });
    const page = await context.newPage();
    await setup(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(screenshotsDir, `${filename}.png`) });
    await context.close();
    console.log(`  ${filename}.png`);
  };

  const renderExtrasView = async (page: Page) => {
    await openDocument(page, baseUrl, "render-extras.md#footnotes");
    await page.evaluate(() => window.scrollBy(0, -56));
    await page.waitForTimeout(300);
  };

  await capture("view", "light", renderExtrasView);
  await capture("view-dark", "dark", renderExtrasView);

  await capture("finder", "light", async (page) => {
    await openDocument(page, baseUrl, "index.md");
    await createKeyboardHelper(page).leader("f", 0, 600);
    await page.keyboard.type("wi", { delay: 90 });
    await page.waitForSelector("input[type=search]");
    await page.waitForTimeout(1200);
  });

  await capture("backlinks", "light", async (page) => {
    await openDocument(page, baseUrl, "wiki-links.md");
    await createKeyboardHelper(page).leader("b", 0, 600);
    await page.waitForSelector(".grep-row");
    await page.waitForTimeout(1200);
  });

  await capture("toc", "light", async (page) => {
    await openDocument(page, baseUrl, "render-extras.md");
    await createKeyboardHelper(page).leader("t", 0, 600);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(1200);
  });

  await capture("editor", "light", async (page) => {
    await openDocument(page, baseUrl, "finding-files.md");
    const keys = createKeyboardHelper(page);
    await keys.press("]", 150);
    await keys.press("]", 500);
    await keys.press("a", 600);
    await page.waitForSelector(".cm-editor");
    await keys.press("j", 150);
    await keys.press("j", 150);
    await keys.press("j", 400);
  });
}

async function recordDemoGif(
  baseUrl: string,
  browser: Browser,
  options: { outDir: string; theme: "light" | "dark"; keepVideoPath?: string },
) {
  const videoTmpDir = await mkdtemp(join(tmpdir(), "markvi-video-"));
  try {
    const context = await browser.newContext({
      viewport: { width: GIF_CONFIG.width, height: GIF_CONFIG.height },
      recordVideo: { dir: videoTmpDir, size: { width: GIF_CONFIG.width, height: GIF_CONFIG.height } },
      colorScheme: options.theme,
    });
    await context.addInitScript(KEY_OVERLAY_SCRIPT);

    const recordingStartedAt = Date.now();
    const page = await context.newPage();
    const keys = createKeyboardHelper(page);

    await openDocument(page, baseUrl, "index.md");
    const trimStartSec = (Date.now() - recordingStartedAt) / 1000;

    await page.waitForTimeout(500);
    await keys.press("j", 300);
    await keys.press("j", 300);
    await keys.press("j", 300);
    await keys.press("]", 120);
    await keys.press("]", 600);

    await keys.leader("f", 900, 400);
    await keys.type("wiki", 800);
    await keys.press("Enter", 800);

    await keys.leader("b", 0, 1500);
    await keys.press("Escape", 300);

    await keys.leader("t", 0, 900);
    await keys.press("ArrowDown", 350);
    await keys.press("ArrowDown", 450);
    await keys.press("Enter", 600);

    await keys.press("a", 600);
    await keys.press("j", 250);
    await keys.press("j", 250);
    await keys.press("o", 200);
    await keys.press("Enter", 120);
    await keys.type("See also [[render-extras]].", 250, 55);
    await keys.press("Escape", 350);
    await keys.press(":", 200);
    await keys.type("w", 200);
    await keys.press("Enter", 800);
    await keys.press(":", 200);
    await keys.type("q", 200);
    await keys.press("Enter", 1500);

    const durationSec = (Date.now() - recordingStartedAt) / 1000 - trimStartSec;
    const video = page.video();
    await context.close();

    const rawVideoPath = await video!.path();
    if (options.keepVideoPath) {
      const targetVideoPath = resolve(options.keepVideoPath);
      await Bun.write(targetVideoPath, Bun.file(rawVideoPath));
      console.log(`  raw video: ${targetVideoPath} (trim: -ss ${trimStartSec.toFixed(2)} -t ${durationSec.toFixed(2)})`);
    }

    const outputGifPath = join(options.outDir, "demo.gif");
    await mkdir(options.outDir, { recursive: true });

    const filterComplex =
      `fps=${GIF_CONFIG.fps},scale=${GIF_CONFIG.outWidth}:-1:flags=lanczos,split[a][b];` +
      `[a]palettegen=max_colors=${GIF_CONFIG.colors}:stats_mode=diff[p];` +
      `[b][p]paletteuse=dither=none:diff_mode=rectangle`;

    const ffmpeg = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-ss",
        trimStartSec.toFixed(2),
        "-t",
        durationSec.toFixed(2),
        "-i",
        rawVideoPath,
        "-vf",
        filterComplex,
        "-loop",
        "0",
        outputGifPath,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );

    if ((await ffmpeg.exited) !== 0) fail("ffmpeg failed while encoding demo.gif");

    const fileSizeMb = ((await stat(outputGifPath)).size / 1024 / 1024).toFixed(1);
    console.log(`  demo.gif (${durationSec.toFixed(1)}s, ${fileSizeMb} MB)`);
  } finally {
    await rm(videoTmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));

  if (options.doGif && !Bun.which("ffmpeg")) {
    fail("ffmpeg is required to build the GIF and was not found in PATH");
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();

  try {
    if (options.doShots) {
      console.log("Screenshots:");
      await withApp((baseUrl) => captureScreenshots(baseUrl, browser, options.outDir));
    }
    if (options.doGif) {
      console.log("GIF:");
      await withApp((baseUrl) =>
        recordDemoGif(baseUrl, browser, {
          outDir: options.outDir,
          theme: options.theme,
          keepVideoPath: options.keepVideoPath,
        }),
      );
    }
  } finally {
    await browser.close();
  }
}

await main();
