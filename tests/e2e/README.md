# E2E de navegador

Verificación funcional del binario Rust contra un navegador real. Usa una copia
temporal de `example/`; el fixture versionado no se modifica.

## Ejecutar

```sh
bun run test:e2e
```

Requisitos: Node, Playwright y Chromium (`playwright` ya es devDependency del
repo; `bunx playwright install chromium` si falta el navegador).

## Cobertura

- Build/servido de assets: HTML con chunks hasheados, JS, CSS, fuente y logos
  servidos por Rust con `ETag`, sin 404 ni peticiones fallidas.
- Rutas: `/view/index.md`, refresh, y ruta anidada `/view/sub/nested.md` con refresh.
- Editor y Vim: entrada `a`, modos `normal`/`insert`, `:w` persistido en disco,
  `:q!` y vuelta a la vista.
- Búsqueda `/` en documento y grep global `space + /`; finder `space + f`.
- Backlinks `space + b`, wiki links renderizados y navegación por clic.
- Preview de la portada, tabs múltiples y `gt`, tema `dark` desde `config.toml`.
- Eventos externos: un cambio en disco recarga la vista abierta por SSE.
- Sin errores de página ni peticiones fallidas inesperadas.

Las capturas de pantalla no se usan como criterio: la aceptación es funcional y
contractual. Los mensajes `net::ERR_ABORTED` de `/api/events` al navegar se
ignoran porque son el cierre esperado del stream SSE.

## Resultado registrado (2026-11-20)

`bun run test:e2e` → **14/14 verificaciones OK**. `cargo test` y
`cargo fmt --check` / `cargo clippy --all-targets` limpios. El harness toma el
manifiesto de `frontend/dist/` (generado por `bun run frontend:build`), que es
determinista; `example/` sin cambios. El binario bajo prueba incorpora esos
assets en compilación.
