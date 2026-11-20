# Diseño de seguridad — filesystem y configuración (fase 4)

Estado: **revisado por `security-reviewer` (2026-11-20), diseño e implementación: sin hallazgos CRÍTICOS ni ALTOS**. Hallazgo MEDIO y residuales, con decisión abajo.

### Revisión de la implementación

Sin críticos/altos. Se corrigieron los dos hallazgos MEDIO antes del cierre:

- Longitudes de keymap/comandos ex medidas en **UTF-16** (`encode_utf16().count()`), no bytes.
- `load_config` distingue archivo ausente (`exists:false`, sin avisos) de archivo ilegible (`exists:true` + `Could not read the file:`).

También se corrigieron: U+FEFF como whitespace, flags/env vacíos tratados como falsy y semilla del nombre temporal reforzada con pid+contador si falla `/dev/urandom`. Pruebas añadidas para los casos CJK, config ilegible, U+FEFF y flag vacío.

## Resultado de la revisión y decisiones

- **MEDIO — MOVE con clave de candado solo de origen** (`src/api.ts:277-291`): dos moves simultáneos al mismo destino pueden sobrescribirse. Se corrige en el puerto Rust (fase 7) tomando también el candado de la ruta destino canónica. Es una desviación deliberada del bug de concurrencia original; se documenta y se somete a aprobación en el checkpoint.
- **INFO — `LoadedConfig.path` absoluto** en `/api/config` y logs: se conserva porque es observable y está en la grabación de la fase 1.
- **BAJO — cuerpo sin límite** en PUT/POST: se conserva el comportamiento; anyadir tope cambiaría el contrato y requiere aprobación.
- **BAJO — profundidad ilimitada de directorios**: se conserva; riesgo residual.
- **BAJO — hardlinks locales**: riesgo residual documentado (requiere acceso FS local).
- Residuales aceptados: TOCTOU `realpath`→uso, sin `O_NOFOLLOW` (no hay dependencia `libc` aprobada), modo solo Unix, fsync de directorio best-effort, orden Unicode `localeCompare`.

## Modelo de amenaza

El servidor recibe rutas y contenidos desde HTTP en localhost. Un atacante puede pedir rutas con `..`, barras invertidas, NUL, segmentos ocultos, enlaces simbólicos internos/externos/rotos/cíclicos, y nombres Unicode. Debe ser imposible:

1. leer o escribir fuera del root;
2. usar un enlace para escapar del root en lectura, escritura, creación, move o borrado;
3. borrar/mover el destino de un enlace cuando se pide actuar sobre el enlace;
4. dejar un archivo a medias o perder el contenido anterior en un fallo de escritura;
5. crear archivos ocultos visibles por la API;
6. proveer una configuración inválida que impida arrancar o cambie la semántica sin aviso.

## Invariantes

- `root` se canonicaliza al arrancar (`realpath`), igual que `server.ts`.
- Toda ruta pedida se comprueba **léxicamente** (`segmentsInside`) y, si existe, también tras `realpath`. Ambas comprobaciones deben pasar.
- `segmentsInside(root, target)` calcula `relative(root, target)` y rechaza `""`, `".."`, `"../"`, absoluta. Un segmento que empieza por `.` o es `node_modules` se considera ignorado.
- No se usa `starts_with` sobre strings para el confinamiento.
- Las operaciones mutantes se hacen sobre la ruta **real** resuelta; para mover/borrar un enlace se usa la ruta del enlace (`entry`), no su destino.
- La extensión `.md` se comprueba sobre la ruta real en lectura y sobre la pedida en creación.

## Algoritmos (espejo de `src/files.ts`)

| Operación | Pasos | Errores |
|---|---|---|
| `resolve_file` | path no vacío y sin NUL → check(target) → `realpath(target)` (404 si falla) → check(real) → `stat(real).is_file()` | 400 missing/invalid, 403 fuera del root, 404 ignorado/inexistente/no archivo |
| `resolve_entry` | `resolve_file` + `realpath(parent(target))` → check(parent) → `entry = join(parent, basename(target))` | igual; 404 si el padre no existe |
| `resolve_writable` | check(target) → `realpath(parent)` (404 "The file's folder does not exist.") → check(parent) → si existe: check(real) + is_file → si `lstat(target)` existe pero `realpath` falla → 403 (symlink roto) → si no existe: `join(parent, basename)` | 400/403/404 |
| `resolve_new` | check(target) → segmentos ignorados dan **400** "Hidden files and folders are not allowed." → subir por ancestors hasta `realpath` existente, comprobando cada real → `lstat(target)` existente da **409** | 400/403/404/409 |
| `list_markdown` | `readdir` ordenado por nombre; omitir ignorados; symlink solo si `realpath` está dentro y no es ignorado; máx. 8 hops; evitar ciclos por cadena de directorios reales; archivos antes que subcarpetas; mapear `path → real` | — |
| `unique_paths` | deduplicar por ruta real, priorizando la ruta directa | — |

## Escritura atómica (espejo de `src/atomic.ts`)

- `write_file_atomic(real_target, data)`:
  1. `stat(target)` para capturar `mode & 0o7777` (o `None` si no existe).
  2. crear `<dir>/.markvi-<12 hex>.tmp` con `create_new(true)`; semilla de 6 bytes leída de `/dev/urandom` (sin dependencias nuevas).
  3. escribir UTF-8, `sync_all()`, cerrar; si había modo, `chmod(temp, mode)` para contrarrestar la umask.
  4. `rename(temp, target)`; si falla, borrar temp y propagar.
  5. `sync_all()` del directorio en mejor esfuerzo.
  6. Si la creación del temp falla con `EACCES`/`EPERM` y el archivo existía, escribir directamente sobre `target` (comportamiento heredado: chmod 0444 → 204, D-011).
- `create_file_exclusive`: mismo temp + `link(temp, target)` (o `write` con `create_new` si el sistema no soporta hardlinks); `EEXIST` → 409; borrar temp.
- `with_file_lock`: cola por clave (ruta real) dentro del proceso; la clave se toma **después** de resolver para que dos peticiones que llegan al mismo real compartan cola.

## TOCTOU y límites conocidos

- `realpath` y el uso posterior no son atómicos: un proceso externo con permisos sobre el directorio podría sustituir un componente entre ambos. La cola por archivo evita la carrera entre peticiones del propio servidor, pero no la de un atacante externo con acceso al filesystem.
- No se añade `libc`/`O_NOFOLLOW` porque no está aprobado: se documenta como riesgo residual y se revisa antes de aceptar.
- `sync_all()` del directorio no existe en todas las plataformas; es mejor esfuerzo, igual que en TS.
- Modos y permisos se preservan solo en Unix (`PermissionsExt`); en otras plataformas no hay equivalente.
- `localeCompare`/Unicode: ver gaps de la fase 3; el orden de listado puede diferir con nombres no ASCII.

## Configuración (espejo de `src/config.ts`)

- Ruta: `--config` > `MARKVI_CONFIG` > `$XDG_CONFIG_HOME/markvi/config.toml` (si XDG es absoluta) > `~/.config/markvi/config.toml`.
- `parse_config(text)`: TOML inválido → defaults + aviso `Syntax error: ...`; texto vacío → defaults sin avisos.
- `validate_config` nunca lanza: cada campo inválido se ignora y genera un aviso con el **mismo texto** que TS. Claves desconocidas → aviso. `leader`, `theme`, `font`, `editor`, `render`, `keymap.leader|view|normal|insert|visual`.
- `parse_sequence`: `space` → `[" "]`; con whitespace → `split_whitespace`, si no → graphemas; máx. 4; una tecla visible.
- `parse_font`: 1–8 nombres; genéricos en minúsculas; otros entre comillas si `/^[\p{L}\p{N} _.-]{1,60}$/`.
- `load_config`: archivo ausente → `exists:false` sin avisos; error de lectura → aviso `Could not read the file: ...`.

## Pruebas obligatorias (sobre copias temporales de `example/`)

traversal (`..`, absoluta, NUL), symlink interno/externo/roto/cíclico, Unicode, espacios y puntos, archivos/carpetas inexistentes, permisos (incluido chmod 0444 → 204), temp+rename sin restos, preservación de modo, fallos de escritura, create/move/delete, root relativo y absoluto. Ninguna sobre `example/` original ni datos reales.
