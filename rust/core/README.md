# Núcleo puro (fase 3)

`cases.json` (65 entradas) + `baseline.json` (salidas grabadas desde TypeScript con Bun 1.4.4) + `src/core/{hash,pure}.rs`.

## Repetir la equivalencia

```bash
bun rust/recording/core_probe.ts > rust/core/baseline.json
cargo test --manifest-path rust/Cargo.toml
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets
```

`tests/core_equivalence.rs` compara **los 65 casos** contra la grabación; 3 tests adicionales cubren los vectores oficiales de wyhash (Zig) y las muestras de `Bun.hash`.

## Unidades portadas

- `hash.rs`: wyhash de Zig (seed 0 = `Bun.hash`), `etag()`.
- `case`, `paths`, `configdefaults`, `wiki`, `hits`, `constants`: en `pure.rs`, con los mismos nombres de campo JSON (`leaderBindings`, `viewRemap`, `vimMappings`).

## Gaps conocidos

- `isCaseSensitive`: `str::to_lowercase()` de Rust puede diferir de `String.prototype.toLowerCase()` de JS en caracteres exóticos; el caso `İstanbul` coincide, pero no se ha demostrado para todo Unicode.
- `WikiIndex::resolve`: el desempate final usa orden de bytes, no `localeCompare` (ICU) de V8. Los casos grabados son ASCII; hay riesgo con nombres Unicode duplicados.
- `heading_slug`: usa `is_alphanumeric`/`is_whitespace` en vez de `\p{L}\p{N}\s`; se probaron acentos y CJK.
- `SearchHit.matches` son rangos **UTF-16** `[desde, hasta)`, como en TS; al calcularlos desde `&str` habrá que convertir desde bytes UTF-8.
- `wiki_links` descarta enlaces inválidos directamente; el regex TS los devuelve y `matchWikiLink` los descarta después. Resultado observable igual.
- Sin N-API ni puentes: el port es directo al crate Rust.
