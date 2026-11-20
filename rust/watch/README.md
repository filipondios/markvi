# Watcher y canal SSE (fase 6)

- `src/watch/mod.rs`: `notify` + debounce de 80 ms, reconciliación de altas/bajas, alias por symlink, difusor `SseHub` y stream manual de SSE (eventos + heartbeat + cancelación).
- `tests/watch_sse.rs`: 4 pruebas reales — create/modify/rename/remove con ráfagas y dedupe, alias por symlink, SSE con evento/heartbeat/reconexión/cliente desconectado/no bloqueo, y apagado por SIGINT/SIGTERM con la misma función que usa el servidor.
- `src/bin/shutdown_probe.rs`: sonda que comprueba `shutdown_signal()` con señales reales.

```bash
cargo test --manifest-path rust/Cargo.toml
python3 rust/recording/smoke_static.py   # sigue 7/7
```

## Dependencias nuevas (justificadas)

- `futures-core`: trait `Stream` para construir el flujo SSE sin `async-stream`.
- `tokio-stream`: `BroadcastStream` (fuente docs.rs/tokio-stream 0.1.19) para convertir `broadcast::Receiver` en `Stream` y poder sondearlo desde `poll_next`.

No se añadió `notify-debouncer-*`: la reconciliación de borrados/renombrados y los alias exigen comparar contra el conjunto conocido, igual que `src/watch.ts`.

## Contrato medido

- Trama de evento: `data: {"type":"change","path":"x.md"}\n\n` (idéntica a TS).
- Heartbeat: `: ping\n\n`, con el primer latido tras el intervalo (25 s en producción; 120 ms en tests).
- Headers: `Cache-Control: no-store`, `Content-Type: text/event-stream`, `X-Accel-Buffering: no` (se aplican en el handler de la fase 7).
- Debounce 80 ms con coalescencia de 150 ms para eventos idénticos consecutivos (create + close_write), para no duplicar un único cambio.

## Revisión de seguridad

Sin hallazgos críticos/altos. Se corrigieron los dos MEDIO: el registro de cancelación usa una guardia que se elimina al soltar el stream (con test de conteo), y `cancel_all` usa `std::sync::Mutex` sin `try_lock`, para que el shutdown no deje streams vivos. También se corrigió: fallo al instalar la señal SIGTERM (ahora queda pendiente en vez de apagarse prematuramente), poda del mapa de coalescencia y `main.rs` delega en `watch::shutdown_signal()`.

## Gaps

- El watcher aún no está cableado al servidor de `main.rs` (ese es el trabajo de la fase 7); las pruebas montan su propio router con `SseHub`.
- No se ha comparado el orden de eventos entre `notify` y `fs.watch` bajo ráfagas muy grandes; el orden del watcher TS ya era ruidoso en la fase 1.
- `shutdown_signal()` se prueba con señales reales sobre la sonda; en la fase 7 se conectará a `with_graceful_shutdown` junto con `SseHub::cancel_all`.
