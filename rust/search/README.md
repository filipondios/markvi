# Búsqueda y backlinks (fase 5)

- `cases.json` (31 casos) + `baseline.json` grabado con `bun rust/recording/search_probe.ts`.
- `src/search/mod.rs`: búsqueda literal, smart-case, offsets UTF-16, recorte de líneas, scan con límites, extracción de enlaces y backlinks.
- `tests/search_equivalence.rs` (31/31) y `tests/search_fs.rs` (2 tests de integración).

## Decisión: sin crate `regex` ni `fancy-regex`

Evidencia: en `src/search.ts:30,67` el query se pasa por `escapeRegExp` y se compila con `g`/`gi`. Es decir, **no hay regex dinámica del usuario**: es búsqueda literal. Añadir un motor de regex no aportaría nada y traería diferencias de semántica.

Mediciones con Bun 1.4.4 (flag `i` sin `u`):

| patrón | texto | `/i` |
|---|---|---|
| `s` | `ſ` | falso |
| `k` | `K` | falso |
| `i` | `İ`, `ı` | falso |
| `σ` | `ς` | verdadero |
| `é` | `É` | verdadero |
| `a.b` | `axb` | falso (literal) |

El crate `regex` con `(?i)` coincide `s` con `ſ` y `k` con `K`, así que se descartó. La implementación usa `to_lowercase()` de un solo carácter con dos excepciones medidas (`ς→σ`, `K→K`) y fija los rangos en unidades UTF-16, como `match.index` de JS.

## Gaps

- `mask_inline_code` y `MARKDOWN_LINK` están implementados con escáner manual, no con la regex original (usa backreferences y lookarounds). Los 31 casos grabados pasan, pero patrones exóticos de Markdown pueden diferir.
- Concurrencia: TS escanea en bloques de 16; Rust es secuencial. El orden de resultados es el mismo porque TS consolida los bloques en orden, pero el rendimiento con muchos archivos no está comparado.
- `scanMarkdown` con archivos que desaparecen entre listado y lectura se maneja igual (se omiten).
- El texto de error/clipping se mide en UTF-16; `String::from_utf16_lossy` puede sustituir surrogates aislados que JS conservaría.

Repetir:

```bash
bun rust/recording/search_probe.ts > rust/search/baseline.json
cargo test --manifest-path rust/Cargo.toml
```
