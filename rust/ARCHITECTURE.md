# Arquitectura Rust mínima (fase 2)

Estado: **aprobada por el usuario (2026-11-20), con smoke test implementado**. No se ha portado comportamiento de negocio.

## Frontera

- Se porta el **backend**: `server.ts` + `src/*.ts` (módulos de producción).
- Se conserva **sin traducir**: `public/` (frontend de navegador: CodeMirror, Vim, Marked, highlight.js, DOMPurify), `example/` (fixture) y `scripts/`.
- Un único crate en `rust/` con un binario `markvi`. Sin `napi-rs`, sin `cdylib`, sin `app lift`. Los futuros puertos son módulos de este crate.
- El contrato a preservar es `rust/recording/baseline.json` (46 casos).

## Crates propuestos

| Crate | Uso | Fuente primaria | Por qué |
|---|---|---|---|
| `tokio` 1 (`full`) | runtime async, señales, canales | docs.rs/tokio; docs.rs/axum exige tokio | runtime de axum; `full` evita microgestión de features en esta fase |
| `axum` 0.8 | rutas HTTP, extractors, SSE | docs.rs/axum (0.8.9, 17 nov 2026): `Router`, `routing::{get,post,...}`, `State`, `serve()` | coincide con las 13 rutas-método inventariadas; `Sse` para `/api/events` |
| `axum::serve::Serve::with_graceful_shutdown` | apagado | docs.rs/axum/.../struct.Serve.html: "prepares a server to handle graceful shutdown when the provided future completes" | señal SIGINT/SIGTERM; ver protocolo abajo |
| `notify` 8 | observar filesystem | docs.rs/notify (8.2.2): `recommended_watcher`, `RecursiveMode::Recursive`, avisa de que editores emiten eventos distintos | sustituye `fs.watch`; la reconciliación propia va encima |
| `serde` + `serde_json` (`preserve_order`) | JSON de la API | docs.rs/serde_json: `Value`, `Map`, dependencia opcional `indexmap` | el orden de claves es observable; `preserve_order` lo mantiene |
| `toml` 1 | `config.toml` | docs.rs/toml (1.2.1): `Table`, `from_str`, serde | parseo de configuración con serde |
| `clap` 4 (`derive`) | CLI `<directorio> [--port] [--config]` | docs.rs/clap | reemplaza `parseArgs` de `node:util` |
| `thiserror` 2 | errores tipados → HTTP | docs.rs/thiserror | un `enum` con status + mensaje exacto evita mapas dispersos |

**Descartados por ahora:**

- `tower-http`: `ServeDir` aplica sus propios `Content-Type`/ETag; aquí hay que reproducir los valores de Bun byte a byte (docs.rs/tower-http `services::fs`). Un manejador pequeño con la tabla de manifiesto es más corto y exacto.
- `indexmap` directo: `serde_json` con `preserve_order` ya lo trae. Solo se añadiría si algún mapa propio llega a la salida.
- `regex`: los patrones de Markvi se construyen en runtime con sintaxis JS (informe `doc.md`); se evaluará en la fase 5 con casos reales antes de elegir `regex`/`fancy-regex`.
- `napi-rs`: D-005 aprobado; no hay puente en la arquitectura final.

## Módulos y tipos de dominio

```
rust/src/
  main.rs        CLI (clap), arranque, señales, salida
  server.rs      Router de axum, middleware Host/Origin, fallback 404
  static_files.rs  sirve el snapshot HTML/assets con headers y ETag del manifiesto
  hash.rs        wyhash de Zig en Rust + tests de vectores
  error.rs       enum AppError { status, message, etag? } → Response JSON
  paths.rs       VIEW_PREFIX, FILES_PREFIX, is_markdown, normalize_path, ... (fase 3)
  config/        defaults, parse TOML, validación y warnings (fase 4)
  fs/            confinement, atomic write, lock, symlinks (fase 4)
  watch.rs       notify + debounce 80 ms + reconciliación (fase 6)
  search.rs      grep (fase 5)
  backlinks.rs   links wiki/Markdown (fase 5)
  api/           handlers por ruta (fase 7)
```

Tipos de dominio (nombres orientativos, se fijan al portar cada unidad):

- `DiskEvent { type: Change|Delete, path: String }` — coincide con `{"type","path"}` de la fase 1.
- `MarkdownEntry { path, real }` — entrada listada; `real` distingue symlink de destino.
- `Hit { path, line, text, matches: Vec<(usize,usize)> }` — offsets en **unidades UTF-16** (los mismos que emite TS; documentar conversión desde UTF-8).
- `Config` con `IndexMap` para `viewRemap`/`vimMappings` si el orden llega al JSON.
- `LoadedConfig { config, warnings, path, exists }` — el `path` absoluto se calcula en runtime.

## Errores y serialización

- `AppError` con variantes que mapean 1:1 a los mensajes grabados: `"Missing or invalid path."`, `"Only .md files are supported."`, `"Path outside the root directory."`, `"File not found."`, `"File or folder not found."`, `"A file already exists at that path."`, `"Host not allowed."`, `"Origin not allowed."`, `"The file changed on disk."` (con `etag`), `"Internal error."`.
- Mapeo de errores de sistema: `ENOENT|ENOTDIR → 404`, `EACCES|EPERM|EROFS → 403`, `EISDIR → 400`, `EEXIST → 409`, `ENOSPC → 507`, resto `500`.
- Todas las respuestas de error: `Response.json({error}, {status, headers: no-store})` con el mismo orden de clave (`error` antes que `etag`).
- `serde_json` con `preserve_order` para que el orden de claves de `/api/config`, `/api/search` y `/api/tree` coincida con el snapshot. Al borrar claves de un `Map` usar `shift_remove`, no `remove` (este último mueve la última clave al hueco).

## Static assets y rutas SPA/view

Bun ** bundlea `public/index.html` al arrancar**: el HTML servido referencia `chunk-*.css` / `chunk-*.js` con nombres con hash y rutas absolutas, y esos assets se sirven con `Cache-Control: public, max-age=31536000, immutable`. `bun build public/index.html --outdir ...` produce nombres distintos (`index-*.css`), así que no reproduce exactamente el servidor original.

Estrategia propuesta (sin reverse-engineering del bundler de Bun):

1. Capturar **una vez** el HTML servido y los assets con hash desde `bun run server.ts` en `rust/assets/` (salida inmutable, solo lectura en runtime).
2. Capturar en `rust/assets/manifest.json`: ruta → `content-type`, `cache-control`, `etag`, `cache-control` del HTML (`no-cache`).
3. `static_files.rs` sirve desde ese directorio: `/` y `/view/*` → HTML; rutas con hash → archivo; cualquier otra cosa → fallback `404 "Not found"` (idéntico al `fetch()` de `server.ts`).
4. El guard `Host`/`Origin` se aplica solo a las rutas `createRoutes`, igual que en Bun: las rutas estáticas no lo tienen.
5. Bun sigue siendo la herramienta de desarrollo/build del frontend; solo se congela su salida para el ejecutable Rust.

Esto mantiene los ETags estáticos aunque su algoritmo no sea reproducible: se sirven los valores medidos, no se recalculan.

## Protocolo de apagado

Bun hace, en `SIGINT`/`SIGTERM`: `watcher.close()` → `server.stop(true)` (corta conexiones activas) → `process.exit(0)`. En Rust:

1. `tokio::signal` recibe la señal.
2. Se cierra el watcher y se cancelan los streams SSE activos (un broadcast de shutdown).
3. `Serve::with_graceful_shutdown` termina el servidor sin esperar a conexiones SSE colgadas.
4. Salida con código 0 y el mismo par de líneas de log (`markvi serving <root>` y la URL).

Riesgo: `with_graceful_shutdown` espera conexiones activas; por eso los SSE deben cancelarse explícitamente antes de que se resuelva el futuro. Se verificará en la fase 6 con un cliente SSE abierto.

## ETags / hash

- `/api/file` y `PUT`/`POST`: `ETag: "` + `wyhash` en hexadecimal minúsculo + `"`.
- Evidencia: `Bun.hash === Bun.hash.wyhash` para `""`, `"a"`, `"hello"`, `"index"` (medido con Bun 1.4.4). El vector oficial de Zig (`lib/std/hash/wyhash.zig`, `seed=0, input=""`) es `0x409638ee2bde459`, idéntico al de Bun.
- El crate `wyhash` 0.6.0 de crates.io **no** coincide (`v1` da `f961f936e29c9345`; `final3` con el secreto estándar da `42bc986dc5eec4d3`). Por tanto: implementar el algoritmo de Zig en `hash.rs` (~80 líneas) con los 7 vectores oficiales + muestras de Bun, **no** usar ese crate. Decisión a aprobar.
- Formato: el ETag es un `u64` en hex sin ceros de relleno, entre comillas; no es criptográfico (D-008).
- ETags estáticos: van en el manifiesto; no se calculan (`Bun.hash` del HTML servido dio `24ad704b43bd7b11`, distinto del `5d2079dee36213ca` observado).

## Smoke test (implementado)

`rust/src/main.rs` sirve solo `rust/assets/` con `/`, `/view/{*path}`, los assets del manifiesto y fallback 404 `Not found`; usa `with_graceful_shutdown` para SIGINT/SIGTERM. No hay API, filesystem ni watcher.

Repetir:

```bash
cargo build --manifest-path rust/Cargo.toml
python3 rust/recording/smoke_static.py
python3 rust/recording/capture_assets.py   # solo si cambia el frontend
```

Resultado: **7/7 respuestas idénticas** al servidor Bun original (status, cabeceras relevantes y SHA-256 del cuerpo) para `/`, `/view/index.md`, los 4 assets y una ruta inexistente. `cargo check` y `cargo build` pasan.

## Límites y checkpoint

Aprobado por el usuario (2026-11-20): backend Rust + frontend TS, sin `napi-rs`, sin `app lift`, sin tocar `public/`/`example/`; lista de crates; `hash.rs` propio; snapshot de assets con manifiesto; protocolo de apagado; smoke test estático.

Siguiente: fase 3, empezando por `hash.rs` y sus vectores.
