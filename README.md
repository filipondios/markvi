**MarkVi** es un visor y editor local de Markdown para tu navegador de confianza, ejecutado con [Bun](https://bun.com/).

## Uso

```sh
bun install
bun run server.ts ./example        # http://127.0.0.1:3000
bun run server.ts ~/notas -p 4000  # otro directorio y puerto
```

La app escucha solo en `127.0.0.1`. El directorio se explora en busca de archivos `.md`, ignorando archivos ocultos y otros no relevantes.

## Atajos

En la vista renderizada:

| Tecla | Acción |
| --- | --- |
| `j` / `k` | Bloque siguiente / anterior |
| `Ctrl-d` / `Ctrl-u` | Media página abajo / arriba |
| `gg` / `G` | Inicio / final del documento |
| `]]` / `[[` | Encabezado siguiente / anterior |
| `/` / `?` | Buscar en el documento |
| `n` / `N` | Coincidencia siguiente / anterior |
| `f` | Seguir un enlace con pistas |
| `gt` / `gT` | Pestaña siguiente / anterior |
| `{n}gt` | Ir a la pestaña n |
| `Ctrl-o` / `Ctrl-i` | Atrás / adelante en el historial |
| `:` | Comando (`:e`, `:q`, `:w`) |
| `a` / `i` | Entrar al editor en modo Normal |
| `espacio` + `f` | Buscar archivos |
| `espacio` + `x` | Cerrar la pestaña activa |

Los contadores funcionan como en Vim: `5j`, `3]]`, `2gt`, `10G`. La tecla
pendiente se muestra en la barra inferior.

## Editor Vim

El editor arranca en modo Normal. Se escribe pulsando otra vez `a` / `i` (o
`o`, `O`, etc.) ya dentro, como en Vim. `Esc` solo vuelve a Normal.

`a` / `i` abren el editor en la línea que se está leyendo (o en el texto
seleccionado, si hay una selección). Un doble clic en un bloque abre el editor
en la línea de ese punto. Al salir, la vista vuelve al bloque de esa línea.
Guardar es solo con comandos ex: `:w`, `:wq`, `:x` o `ZZ`.

| Comando | Acción |
| --- | --- |
| `:w` | Guardar sin salir |
| `:wq`, `:x`, `ZZ` | Guardar y volver a la vista |
| `:q` | Volver a la vista si no hay cambios; si los hay, avisa y no sale |
| `:q!`, `ZQ` | Descartar los cambios y volver a la vista |
| `:set nu` / `:set nonu` | Números de línea absolutos (activos por defecto) |
| `:set rnu` / `:set nornu` | Números de línea relativos (desactivados por defecto) |
| `:set so=N` | Margen de líneas visibles alrededor del cursor (por defecto `0`) |

Salir del editor siempre vuelve a la vista renderizada de la misma pestaña:
`:q` nunca cierra la pestaña. Para cerrarla se usa `espacio` + `x`.

Con el ajuste de línea activo, `j` / `k` avanzan por líneas de pantalla en
Normal y Visual. Con un operador (`dj`, `yk`) siguen contando líneas lógicas
del archivo. `gt` / `gT` cambian de pestaña también desde modo Normal. El
registro por defecto es interno del editor, no el portapapeles del sistema.

El navegador se queda con `Ctrl+W`, `Ctrl+T` y `Ctrl+N` (cerrar pestaña, abrir
pestaña y ventana nueva), así que no se pueden usar como en Vim.

## Recarga y conflictos

El servidor vigila el directorio con `fs.watch` y avisa por SSE. Si un archivo
cambia en disco y no hay cambios locales, la pestaña se recarga sola. Si hay un
borrador sin guardar, la barra inferior muestra el conflicto con acciones para
recargar o sobrescribir. Los guardados usan `ETag`/`If-Match`: si el archivo
cambió entre la lectura y el guardado, el servidor responde `409` en vez de
pisar los cambios ajenos.

## Compilar como comando

```sh
bun run build # generando dist/markvi
install -m 755 dist/markvi ~/.local/bin/markvi
markvi ~/notas # cambia notas por tu directorio
```

El binario incluye el frontend y no necesita `bun` instalado para ejecutarse.
