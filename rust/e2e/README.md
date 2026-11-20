# E2E de navegador (fase 8)

Verificación funcional del binario Rust contra un navegador real. Usa una copia
temporal de `example/`; el fixture versionado no se modifica.

## Ejecutar

```sh
cargo build --manifest-path rust/Cargo.toml
node rust/e2e/browser_e2e.mjs
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

`node rust/e2e/browser_e2e.mjs` → **14/14 verificaciones OK** en dos ejecuciones
consecutivas. `cargo test` → 25 tests; `cargo fmt --check` y
`cargo clippy --all-targets` limpios. `python3 rust/recording/capture_assets.py`
es determinista; `example/` sin cambios.

Nota: `capture_assets.py` descubre también los assets referenciados desde el
bundle JS/CSS (el logo de la portada no aparece en el HTML), por lo que
`rust/assets/` incluye `logo-full-*.png` además de los cuatro capturados antes.
