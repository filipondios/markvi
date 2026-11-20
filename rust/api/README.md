# API y servidor (fase 7)

`src/api/mod.rs` + `src/main.rs` cablean los módulos ya probados (`fs`, `config`, `search`, `watch`, `core`, estáticos) a las 13 rutas-método del original.

## Replay de equivalencia

El harness de la fase 1 admite cambiar el comando del servidor sin reescribirlo:

```bash
cargo build --manifest-path rust/Cargo.toml
MARKVI_SERVER_CMD="rust/target/debug/markvi {root} --port {port}" \
MARKVI_WATCHER_CMD="rust/target/debug/watcher_probe {root}" \
MARKVI_BASELINE_OUT=rust/recording/baseline-rust.json \
python3 rust/recording/record.py
```

Resultado: **46/46 casos**, con cero diferencias semánticas frente a `rust/recording/baseline.json` (status, headers normalizados sin `date`, body, estado del filesystem, tramas SSE y eventos del watcher). Los valores de ETag coinciden exactamente porque el puerto usa el mismo wyhash.

## Decisiones

- **No se usó el flujo whole-app de rust-anything para el port completo.** `analyze` no tiene opción de excluir directorios e incluye `public/` como una pieza tangled de 6371 líneas; `app lift` portaría el frontend. Se mantuvo el harness propio de fases 1/3/5/6. No hay `napi-rs`, `front-door`, `wire` ni `lift`.
- **Sin `If-None-Match`**: el original no lo implementa (verificado con grep), así que no se añadió respuesta 304.
- **MOVE** bloquea origen y destino en orden de claves (A-019).
- Las rutas API se despachan con un único handler `any()` para que axum no añada la cabecera `Allow` en un 404 de método no soportado (el original devuelve 404 sin esa cabecera).
- El apagado usa `watch::shutdown_signal()`: al recibir SIGINT/SIGTERM se cierra el watcher (y se cancelan los streams SSE) antes de `with_graceful_shutdown`.

## Revisión de seguridad

Sin hallazgos críticos/altos. Corregidos los dos MEDIO: `DELETE` vuelve a exigir extensión `.md` (el original devuelve 400 y conserva `config.toml`, verificado contra Bun), y el apagado usa `watcher.lock().await.close()` para no dejar streams SSE vivos si un cliente está conectado. Corregidos también tres BAJOS: decode `%` estricto (400), `+` como espacio en query, y `/files/*` con dispatch unificado para no devolver `Allow` en un 404. Nuevas regresiones en `tests/api_regressions.rs` (3 tests). Confirmado con Bun: `DELETE config.toml → 400`, `/files/%ZZ.md → 400`.

## Gaps

- `main.rs` no implementa el modo `MARKVI_DEV=1` de Bun (cambia el bundle y HMR); el binario sirve siempre el snapshot de `rust/assets/`.
- La firma de uso de CLI dice `markvi <directory> ...`; Bun mostraba el nombre con el que se invocaba (`bun run server.ts`). Los mensajes de error y códigos coinciden.
- No se ha ejecutado un E2E de navegador (fase 8); el replay cubre HTTP + estáticos + SSE + watcher.
- Concurrencia real (20 PUT simultáneos) sigue sin grabarse en el catálogo; el bloqueo por archivo está implementado y probado a nivel de unidad.
