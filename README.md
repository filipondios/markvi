**MarkVi** es un visor y editor local de Markdown para tu navegador de confianza, ejecutado con [Bun](https://bun.com/).

## Uso

```sh
bun install
bun run server.ts ./example        # http://127.0.0.1:3000
bun run server.ts ~/notas -p 4000  # otro directorio y puerto
```

La app escucha solo en `127.0.0.1`. El directorio se explora en busca de archivos `.md`, ignorando archivos ocultos y otros no relevantes.

## Atajos

| Tecla | Acción |
| --- | --- |
| `e` | Entrar al editor desde la vista |
| `Esc` | Guardar y volver a la vista |
| `Ctrl+S` | Guardar |
| `espacio` + `f` | Buscar archivos |
| `espacio` + `←` / `→` | Cambiar de pestaña |
| `espacio` + `x` | Cerrar la pestaña activa |

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
