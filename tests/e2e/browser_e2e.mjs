/**
 * E2E de navegador sobre el binario Rust y una copia temporal de example/.
 * Uso: bun run test:e2e
 * Requiere Playwright + Chromium (devDependency del repo). No modifica example/.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { appendFile, cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const BIN = join(ROOT, "target/debug/markvi");
const VIEW = (p) => `/view/${p}`;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function waitFor(fn, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${message}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => res(port));
    });
  });
}

async function withServer(configText, fn) {
  const dir = await mkdtemp(join(tmpdir(), "markvi-e2e-"));
  const vault = join(dir, "notes");
  const config = join(dir, "config.toml");
  const serverLog = join(dir, "server.log");
  let out = "";
  try {
    await cp(join(ROOT, "example"), vault, { recursive: true });
    await writeFile(config, configText);
    const port = await freePort();
    const log = await stat(BIN).catch(() => null);
    assert(log?.isFile(), `binario no encontrado: ${BIN} (¿cargo build?)`);
    const proc = spawn(BIN, [vault, "--port", String(port), "--config", config], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (out += d.toString()));
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitFor(
        async () => {
          try {
            return (await fetch(`${base}/api/tree`)).ok;
          } catch {
            return false;
          }
        },
        `servidor Rust no arrancó en ${port}: ${out}`,
      );
      return await fn({ base, vault, dir });
    } finally {
      proc.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => proc.once("exit", r)),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await writeFile(serverLog, out);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function openPage(browser, errors) {
  return browser.newContext({ viewport: { width: 1100, height: 720 } }).then(async (ctx) => {
    const page = await ctx.newPage();
    // Navegar con el editor abierto puede disparar un beforeunload; se acepta.
    page.on("dialog", (d) => d.accept());
    page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()} @ ${m.location()?.url ?? ""}`);
    });
    page.on("requestfailed", (r) => {
      // SSE y peticiones en vuelo se abortan al navegar/cerrar: esperado.
      if (r.failure()?.errorText === "net::ERR_ABORTED" &&
          /\/(api\/(events|file|tree))?$/.test(new URL(r.url()).pathname)) return;
      errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
    });
    return page;
  });
}

async function closeEditor(page) {
  if (!(await page.locator(".cm-editor").count())) return;
  await page.keyboard.press("Escape");
  await page.keyboard.press(":");
  await page.keyboard.type("q!");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await page.locator("#status-mode").getAttribute("data-mode")) === "view", "cerrar editor");
}

async function gotoView(page, base, doc) {
  // El editor se restaura tras recargar: se cierra para aislar cada verificación.
  await closeEditor(page);
  await page.goto(`${base}${VIEW(doc)}`);
  await page.waitForSelector("#content h1");
  await page.waitForTimeout(200);
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message ?? error) });
    console.log(`  FAIL  ${name}: ${error.message ?? error}`);
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    console.log("Servidor Rust — assets, rutas y funciones del navegador:");

    await withServer("", async ({ base, vault }) => {
      const errors = [];
      const page = await openPage(browser, errors);

      await check("assets servidos desde Rust (HTML + chunks con hash)", async () => {
        const resp = await fetch(`${base}/`);
        assert(resp.status === 200, `GET / -> ${resp.status}`);
        const html = await resp.text();
        assert(resp.headers.get("content-type")?.includes("text/html"), "content-type de / no es HTML");
        assert(/chunk-[\w-]+\.js/.test(html) && /chunk-[\w-]+\.css/.test(html), "HTML sin chunks hasheados");
        const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]).filter((p) => p !== "/");
        assert(refs.length >= 3, `solo ${refs.length} assets referenciados`);
        for (const ref of refs) {
          const r = await fetch(`${base}${ref}`);
          assert(r.status === 200, `GET ${ref} -> ${r.status}`);
          assert((await r.arrayBuffer()).byteLength > 0, `${ref} vacío`);
          assert(r.headers.get("etag"), `${ref} sin ETag`);
        }
        // Verificación contractual de todo el manifiesto, incluidos assets que
        // solo se referencian desde el bundle JS (p. ej. el logo de la portada).
        const manifest = JSON.parse(await readFile(join(ROOT, "frontend/dist/manifest.json"), "utf8"));
        for (const [ref, entry] of Object.entries(manifest.assets)) {
          const r = await fetch(`${base}${ref}`);
          assert(r.status === 200, `GET ${ref} -> ${r.status}`);
          assert(r.headers.get("etag") === entry.etag, `ETag de ${ref} distinto del manifiesto`);
          assert(r.headers.get("content-type") === entry.content_type, `content-type de ${ref} distinto`);
        }
      });

      await check("ruta directa /view/index.md y refresh", async () => {
        await gotoView(page, base, "index.md");
        assert((await page.locator("#content h1").textContent()) === "Welcome to MarkVi", "h1 incorrecto");
        await page.reload();
        await page.waitForSelector("#content h1");
        assert((await page.locator("#content h1").textContent()) === "Welcome to MarkVi", "h1 tras refresh incorrecto");
        assert(page.url().endsWith(VIEW("index.md")), "URL tras refresh incorrecta");
      });

      await check("ruta directa y refresh con prefijo anidado", async () => {
        await mkdir(join(vault, "sub"));
        await writeFile(join(vault, "sub/nested.md"), "# Nested\n\nContenido anidado.\n");
        await gotoView(page, base, "sub/nested.md");
        assert((await page.locator("#content h1").textContent()) === "Nested", "h1 anidado incorrecto");
        await page.reload();
        await page.waitForSelector("#content h1");
        assert((await page.locator("#content h1").textContent()) === "Nested", "h1 anidado tras refresh incorrecto");
      });

      await check("editor Vim: entrada, modos y guardado :w en disco", async () => {
        const marker = "E2E_SAVED_MARKER";
        await gotoView(page, base, "index.md");
        await page.keyboard.press("a");
        await page.locator(".cm-editor").waitFor();
        assert((await page.locator("#status-mode").getAttribute("data-mode")) === "normal", "editor no starts en modo normal");
        await page.keyboard.press("o"); // línea nueva: no rompe el h1 del documento
        await waitFor(async () => (await page.locator("#status-mode").getAttribute("data-mode")) === "insert", "modo insert");
        await page.keyboard.type(marker);
        assert(await page.locator("#status-dirty").isVisible(), "indicador de cambios no visible");
        await page.keyboard.press("Escape");
        await waitFor(async () => (await page.locator("#status-mode").getAttribute("data-mode")) === "normal", "modo normal");
        await page.keyboard.press(":");
        await page.keyboard.type("w");
        await page.keyboard.press("Enter");
        await waitFor(async () => (await readFile(join(vault, "index.md"), "utf8")).includes(marker), "guardado en disco");
        await waitFor(async () => (await page.locator("#status-state").textContent()) === "Saved", "estado no es Saved tras :w");
        assert(await page.locator("#status-dirty").isHidden(), "indicador de cambios sigue visible");
        await page.waitForTimeout(250);
        await page.keyboard.press(":");
        await page.keyboard.type("q!");
        await page.keyboard.press("Enter");
        await waitFor(async () => (await page.locator("#status-mode").getAttribute("data-mode")) === "view", "vuelta a la vista");
        await page.locator("#content h1").waitFor({ state: "visible" });
      });

      await check("búsqueda en documento (/) y grep global (space + /)", async () => {
        await gotoView(page, base, "index.md");
        await page.keyboard.press("/");
        await page.locator("#prompt").waitFor({ state: "visible" });
        assert((await page.locator("#prompt-prefix").textContent()) === "/", "prefijo de búsqueda incorrecto");
        await page.keyboard.type("tour");
        assert((await page.locator("#prompt-input").inputValue()) === "tour", "input de búsqueda no recibió el texto");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Escape");
        await waitFor(async () => await page.locator("#prompt").isHidden(), "prompt no se cerró");

        await page.keyboard.press("Space");
        await page.keyboard.press("/");
        await page.keyboard.type("MarkVi");
        await waitFor(async () => (await page.locator(".grep-row").count()) > 0, "sin resultados de grep");
      });

      await check("finder (space + f) abre archivo por nombre", async () => {
        await gotoView(page, base, "index.md");
        await page.keyboard.press("Space");
        await page.keyboard.press("f");
        const input = page.locator('input[placeholder="Find file…"]');
        await input.waitFor({ state: "visible" });
        await page.keyboard.type("wiki");
        assert((await input.inputValue()) === "wiki", "finder no recibió el texto");
        // El query va con debounce: sin esperar al resultado, Enter abriría la
        // selección inicial en lugar de wiki-links.md.
        await waitFor(
          async () => (await page.locator(".finder-result").allTextContents()).some((t) => t.includes("wiki-links.md")),
          "finder no mostró wiki-links.md",
        );
        await page.keyboard.press("Enter");
        await waitFor(() => page.url().endsWith(VIEW("wiki-links.md")), "finder no abrió wiki-links.md");
        await page.locator("#content h1").waitFor({ state: "visible" });
        await waitFor(async () => (await page.locator("#content h1").textContent()) === "Wiki links", "h1 tras finder incorrecto");
      });

      await check("backlinks (space + b) sobre wiki-links.md", async () => {
        await gotoView(page, base, "wiki-links.md");
        await page.keyboard.press("Space");
        await page.keyboard.press("b");
        await waitFor(async () => (await page.locator(".grep-row").count()) > 0, "sin backlinks");
      });

      await check("wiki links: enlaces renderizados y navegación por clic", async () => {
        await gotoView(page, base, "index.md");
        const links = page.locator('#content a[href^="/view/"]');
        assert((await links.count()) >= 5, "faltan enlaces wiki en index.md");
        await page.locator('#content a[href="/view/wiki-links.md"]').first().click();
        await waitFor(() => page.url().endsWith(VIEW("wiki-links.md")), "clic en wiki link no navegó");
        await page.locator("#content h1").waitFor({ state: "visible" });
        await waitFor(async () => (await page.locator("#content h1").textContent()) === "Wiki links", "h1 tras wiki link incorrecto");
      });

      await check("tabs: multiples pestañas, selección y gt", async () => {
        const tabs = page.locator("#tabs .tab-link");
        assert((await tabs.count()) >= 2, "no se crearon varias pestañas");
        assert((await page.locator('#tabs .tab-link[aria-selected="true"]').count()) === 1, "debe haber una pestaña activa");
        const before = page.url();
        await page.keyboard.press("g");
        await page.keyboard.press("t");
        await waitFor(() => page.url() !== before, "gt no cambió de pestaña");
      });

      await check("preview del índice en /", async () => {
        await page.goto(`${base}/`);
        await page.waitForSelector("#content a[data-path]");
        await page.keyboard.press("j"); // foco/selección del primer archivo -> preview
        await page.locator(".index-preview").waitFor({ state: "visible" });
        await waitFor(async () => (await page.locator(".index-preview-body").textContent())?.length > 3, "preview sin contenido");
      });

      await check("eventos externos: cambio en disco recarga la vista abierta", async () => {
        const marker = "E2E_EXTERNAL_CHANGE";
        await gotoView(page, base, "index.md");
        await appendFile(join(vault, "index.md"), `\n${marker}\n`);
        await waitFor(
          async () => (await page.locator("#content").textContent()).includes(marker),
          "el navegador no recibió el cambio externo (SSE/watcher)",
          15000,
        );
      });

      await check("sin errores de página ni peticiones fallidas inesperadas", async () => {
        assert(errors.length === 0, errors.join(" | "));
      });

      await page.context().close();
    });

    console.log("Configuración de tema:");
    await withServer('theme = "dark"\n', async ({ base }) => {
      const errors = [];
      const page = await openPage(browser, errors);
      await check("tema oscuro desde config.toml", async () => {
        await gotoView(page, base, "index.md");
        assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "data-theme no es dark");
        await page.reload();
        await page.waitForSelector("#content h1");
        assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "tema dark no persiste tras refresh");
      });
      await check("sin errores de página con tema oscuro", async () => {
        assert(errors.length === 0, errors.join(" | "));
      });
      await page.context().close();
    });
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nResultado: ${results.length - failed.length}/${results.length} verificaciones OK`);
  if (failed.length) {
    console.log("Fallos:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

await main();
