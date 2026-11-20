# Decisiones versionadas del port (registro canónico)

`migration/DECISIONS.md` es un espejo local (ignorado por Git). Este archivo es el registro versionado.

Estados: `proposed`, `approved`, `rejected`, `superseded`.

## A-001 — Frontera de migración

Estado: approved (usuario, 2026-11-20)

Backend (`server.ts` + lógica de `src/`) a Rust. `public/`, `example/` y `scripts/` quedan fuera del port.

## A-002 — `example/`

Estado: approved (usuario)

Se conserva; fixture E2E. Pruebas mutantes solo sobre copias temporales.

## A-003 — Runtime de producción

Estado: approved (usuario)

Binario Rust en producción. Bun puede seguir como herramienta de build/test del frontend.

## A-004 — HTTP

Estado: approved (usuario, 2026-11-20)

Tokio + Axum 0.8, con `with_graceful_shutdown`. Fuente: docs.rs/axum.

## A-005 — Bridge

Estado: approved (usuario)

Sin `napi-rs` en la arquitectura final. Sin `app lift` global.

## A-006 — Forma de la app

Estado: approved (usuario, corrección)

HTTP server, no `library`: `Bun.serve` + `package.json.module`. El falso negativo del analyzer está documentado.

## A-007 — Build del frontend

Estado: approved (usuario)

Se congela la salida servida por Bun en `rust/assets/` + manifiesto; Rust la sirve. No se cambia el bundler.

## A-008 — Test de permisos

Estado: approved (usuario, opción a)

PUT sobre archivo `0444` devuelve 204 y conserva el modo; no se corrige el test en el port.

## A-009 — Grabación

Estado: approved (lead)

Harness propio en `rust/recording/`; no `rust-anything app record --http` (descarta ETag, no captura SSE, sin reset por petición).

## A-010 — ETag de archivos

Estado: approved (usuario, 2026-11-20)

Implementar el wyhash de Zig (vector `0x409638ee2bde459` para "") en `hash.rs` con tests. No usar el crate `wyhash` de crates.io: sus vectores no coinciden con Bun.

## A-011 — ETag de estáticos

Estado: approved (usuario, 2026-11-20)

Servir los ETags medidos desde `rust/assets/manifest.json`; no intentar recalcular el algoritmo interno de Bun.

## A-012 — Watcher

Estado: approved (usuario, 2026-11-20)

`notify` 8 + debounce de 80 ms y reconciliación propia (no `notify-debouncer-*`): los eventos de rename/borrado fuera del root requieren comparar contra el conjunto conocido, como hace `src/watch.ts`.

## A-013 — Serialización

Estado: approved (usuario, 2026-11-20)

`serde` + `serde_json` con `preserve_order`; `toml` 1 para config; `thiserror` para `AppError`; `clap` 4 para CLI. Sin `indexmap` directo ni `tower-http` por ahora.

## A-014 — Smoke test estático

Estado: approved e implementado (2026-11-20): 7/7 respuestas idénticas al original

Solo si se autoriza en el checkpoint: servidor mínimo que sirve `rust/assets/` sin API, comparado contra el original con `curl`.

## A-015 — Seguridad

Estado: mandatory

Confinamiento al root, symlinks, TOCTOU, escrituras atómicas, Host/Origin, cierre SSE. Toda decisión nueva requiere `security-reviewer` y tests de traversal/TOCTOU.

## A-016 — Equivalencia observable

Estado: mandatory

Métodos, rutas, status, headers, body, errores, orden, ETags, eventos y CLI. Diferencias requieren aprobación explícita.

## A-017 — Core puro (fase 3)

Estado: implemented (2026-11-20)

`src/core/{hash,pure}.rs` + 65 casos grabados desde TS. Sin N-API. Hash de Bun reproducido con la implementación de Zig. Gaps de Unicode/`localeCompare` documentados en `rust/core/README.md`.

## A-018 — Filesystem y configuración (fase 4)

Estado: implemented (2026-11-20), aprobado en checkpoint

## A-019 — MOVE: bloqueo de destino

Estado: approved (usuario, 2026-11-20)

Desviación deliberada respecto al bug de concurrencia del original: en fase 7 se tomará también el candado de la ruta destino canónica para evitar que dos moves sobrescriban el mismo destino.

## A-020 — Búsqueda sin crate regex

Estado: implemented (2026-11-20)

El query se escapa en TS, así que la búsqueda es literal. Sin `regex`/`fancy-regex`: se replican las excepciones medidas de `/i` sin `u` de Bun y los offsets UTF-16. 31/31 casos grabados coinciden.

## A-021 — Watcher y SSE (fase 6)

Estado: implemented (2026-11-20), revisión de seguridad sin críticos/altos

## A-022 — API y servidor (fase 7)

Estado: implemented (2026-11-20), revisión sin críticos/altos, replay 46/46 con 0 diffs

Replay 46/46 con cero diferencias semánticas frente al original. No se usó `app lift`/`front-door`/`wire`: el flujo whole-app de rust-anything no puede excluir `public/`. `public/` sigue siendo frontend TS. Sin `If-None-Match` (no existe en el original). MOVE con bloqueo de destino (A-019).

`notify` + reconciliación propia, `SseHub`, stream manual con heartbeat y cancelación. Dependencias nuevas justificadas: `futures-core` y `tokio-stream`. 4 pruebas reales (incluidas señales SIGINT/SIGTERM). El cableado al servidor y el `with_graceful_shutdown` quedan para la fase 7.

`src/fs/mod.rs` y `src/config/mod.rs` + 9 tests sobre copias temporales. Diseño revisado por `security-reviewer` sin hallazgos críticos/altos. Desviación propuesta: bloquear también el destino en MOVE (fase 7) para evitar la carrera MEDIO del original; requiere aprobación explícita.
