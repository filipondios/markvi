# Baseline HTTP del original (fase 1)

Catálogo y grabación del comportamiento observable de Markvi **antes** de portar nada a Rust.

- `cases.json`: catálogo versionado. Las rutas y métodos salen de `src/api.ts`, `server.ts`, `src/paths.ts` y `src/constants.ts`, no de nombres deducidos.
- `record.py`: harness que ejecuta cada caso contra el servidor Bun original.
- `watcher_probe.ts`: sonda separada que observa `createFileWatcher` directamente.
- `baseline.json`: grabación generada (46/46 casos passing; dos ejecuciones consecutivas idénticas salvo `timestamp` y cabeceras `Date`).

## Cómo repetirlo

Desde la raíz del repositorio, sin modificar código:

```bash
python3 rust/recording/record.py            # regraba los 46 casos -> baseline.json
python3 rust/recording/record.py tree-get   # solo casos concretos (ids)
```

Requisitos: Bun 1.4.4 y Python 3 con stdlib. El script elige un puerto libre, copia `example/` a un `TemporaryDirectory`, añade los archivos sintéticos descritos en `cases.json`, arranca `bun run server.ts <copia> --port <puerto>` y para el servidor tras cada caso. **`example/` solo se lee**: verificado con `git status --short example/` y `git diff --stat example/` vacíos tras varias ejecuciones.

Cada caso mutante empieza con una copia nueva del fixture, así que no hay dependencia entre casos. Las expectativas se comprueban automáticamente; si una falla, el script termina con exit 1 y guarda lo observado en `baseline.json` para revisarlo (no se reescribe la expectativa automáticamente).

## Cobertura conocida

| Grupo | Casos | Superficie |
|---|---:|---|
| `static` | 3 | `/`, `/view/*`, fallback 404 de `fetch()` |
| `read` | 18 | `GET /api/tree`, `/api/config`, `/api/file`, `/files/*`, `/api/search`, `/api/backlinks`; errores 400/403/404 y traversal/symlink |
| `guard` | 2 | `Host` ajeno y `Origin` ajeno → 403 JSON, sin efectos |
| `mutate` | 19 | `PUT` (con/sin `If-Match`, `create=1`), `POST`, `DELETE`, `POST /api/move`, chmod 0444; con estado del filesystem después de cada caso |
| `flow` | 1 | GET → PUT con el `ETag` obtenido (concurrencia `If-Match`) |
| `sse` | 1 | `GET /api/events`: headers, evento `change`, heartbeat `: ping` (25 s), reconexión |
| `watcher` | 1 | `createFileWatcher` directo: `change`/`delete`, including rename |

Rutas y métodos cubiertos (todos los del código): `GET /`, `GET /view/*`, `GET /api/tree`, `GET|PUT|POST|DELETE /api/file`, `POST /api/move`, `GET /api/config`, `GET /api/search`, `GET /api/backlinks`, `GET /api/events`, `GET /files/*`. No hay otros en `createRoutes` ni en `server.ts`.

Detalles capturados: status, cabeceras (`Cache-Control`, `Content-Type`, `ETag`, `Content-Security-Policy`, `X-Content-Type-Options`, `X-Accel-Buffering`), cuerpo exacto (incluido el orden de claves JSON), forma del ETag, estado del archivo tras mutar (contenido, ausencia, destino de symlink y permisos).

### Comportamientos confirmados que conviene no perder

- `ETag` de `/api/file` es `"` + hexadecimal + `"`, calculado con `Bun.hash` (D-008).
- `/` y `/view/*` **no** pasan por el guard de `Host`/`Origin`: sirven HTML con `Cache-Control: no-cache` y un ETag propio de Bun.
- `/api/*` y `/files/*` sí pasan por el guard; `/files/*` añade `Content-Security-Policy: sandbox` y `X-Content-Type-Options: nosniff`.
- Bun no envía las cabeceras de una respuesta SSE hasta el primer evento o el heartbeat de 25 s; la sonda de reconexión dispara un evento para poder medirla.
- PUT sobre un archivo con modo `0444` devuelve **204** y sobrescribe (D-011), conservando el modo.
- Los errores de archivo no existente dicen `"File not found."`; los de destino existente, `"A file already exists at that path."`.

## Gaps explícitos

1. **Ruido temporal.** `timestamp` y las cabeceras `Date` cambian entre ejecuciones; se normalizan al comparar grabs, no forman parte del contrato medido.
2. **Orden de eventos del watcher.** `fs.watch` emite el mismo conjunto de eventos en distinto orden entre ejecuciones (carrera entre rename y reconciliación). `baseline.json` guarda la lista ordenada; el orden no se trata como contrato.
3. **Concurrencia real no incluida.** Los tests de 20 guardados simultáneos y 10 POST simultáneos de `src/api.write.test.ts` no están en el catálogo: el harness es secuencial. Quedan para verificación de la fase 4.
4. **Heartbeat y SSE ampliado.** Se mide un heartbeat y una reconexión; no se miden cierre por shutdown con cliente abierto ni latidos múltiples. El heartbeat añade ~25 s a la grabación.
5. **Config dependiente del entorno.** `/api/config` incluye un campo `path` absoluto y `exists`; la expectativa fija `theme`, `leader`, `editor.number`, `warnings` y `exists`, e ignora `path`. No se grabó aún un config con valores no default.
6. **Frontend no cubierto.** No hay E2E de navegador en esta fase; `public/` se conserva y se verificará en la fase 8.
7. **Recursos estáticos reales.** `img.svg` es sintético; el HTML real se sirve tal cual, pero no se valida el bundle completo de `public/` (CSS, fuentes, imágenes).
8. **Errores de sistema difíciles de inducir** (`ENOSPC`, `EROFS`, `EACCES` reales) no se graban: el test de permisos se limita al caso chmod de D-011.

## Por qué NO se usó `rust-anything app record --http`

Evaluado contra la versión instalada (2.0.2) y su código fuente, no contra una guía antigua:

- `src/http.rs` excluye `etag` de las cabeceras grabadas (`SKIP_HEADERS`), justo el contrato de `If-Match` de Markvi.
- `read_response` espera a que termine el cuerpo: una respuesta SSE abierta no encaja en el recorder.
- `run_all` arranca el servidor una vez y envía todas las peticiones en orden; `--fresh` solo restaura el fixture **por arranque**, no entre peticiones. Los casos mutantes se contaminarían.
- Los traps (`fn traps`) sustituyen segmentos de ruta, valores de query y cuerpos de **todas** las peticiones base, incluidas PUT/POST/DELETE; necesitarían `--no-traps`.
- `app::resolve_word` canonicaliza `./example` a la ruta absoluta del repositorio original, así que `--fresh` no protegería `example/` de peticiones mutantes.
- El recorder funde las dos ejecuciones en `[..]` / `...`, lo que pierde exactitud byte a byte.

Decisión: no usarlo para la grabación principal (D-012). Se mantiene `analyze` como apoyo y se reserva `record`/`diff`/`gate` para unidades puras cuando el objetivo sea reutilizar Rust desde Bun, no para el contrato HTTP del servidor.

## Estado del checkpoint

Catálogo: `rust/recording/cases.json` (46 casos). Grabación: `rust/recording/baseline.json` (46/46). Repetible: dos ejecuciones consecutivas idénticas tras normalizar `timestamp` y `Date`. `example/` intacto. Sin código de producción modificado.
