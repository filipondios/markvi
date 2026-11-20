# Filesystem y configuración (fase 4)

- `SECURITY-DESIGN.md`: modelo de amenaza, invariantes y resultado de la revisión previa.
- `src/fs/mod.rs`: confinamiento (`resolve_file`, `resolve_entry`, `resolve_writable`, `resolve_new`), listado con symlinks, escritura atómica y cola por archivo.
- `src/config/mod.rs`: resolución de ruta, validación de TOML y avisos.
- `tests/fs_equivalence.rs`: 10 tests sobre directorios temporales derivados de los contratos de `src/*.test.ts`. `example/` nunca se escribe.

Resultado: 14 tests totales en verde (3 hash + 1 equivalencia core + 10 fs/config), fmt/clippy limpios salvo dependencias aún no usadas, smoke estático 7/7. Dos revisiones de `security-reviewer` (diseño e implementación) sin hallazgos críticos/altos.

```bash
cargo test --manifest-path rust/Cargo.toml
cargo fmt --manifest-path rust/Cargo.toml -- --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets
```

## Decisiones y gaps

- El revisor encontró un riesgo **MEDIO** en el original: MOVE bloquea solo el origen, así que dos moves simultáneos al mismo destino pueden sobrescribirse. El puerto Rust lo corregirá en la fase 7 bloqueando también el destino; es una desviación deliberada del bug, pendiente de aprobación en el checkpoint.
- Se conservan: `LoadedConfig.path` absoluto, cuerpo sin límite de tamaño, profundidad de directorios sin tope y hardlinks locales (riesgos INFO/BAJOS documentados en el diseño).
- Residuales: TOCTOU `realpath`→uso, sin `O_NOFOLLOW`, modo preservado solo en Unix, fsync de directorio best-effort, orden `localeCompare` no reproducido.
- El test de chmod 0444 confirma la decisión D-011: la escritura termina en éxito (204 en HTTP) y conserva el modo.
