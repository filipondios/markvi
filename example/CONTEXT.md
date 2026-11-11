# CONTEXT

Visor/editor local de Markdown con Bun. Plan y fases en `TODO.md`. Mantener este archivo breve y actualizarlo al cerrar cada fase.

## Estado

Fases 0–7b hechas. Siguiente: navegación Vim en la vista renderizada (Fase 8).

## Uso

```sh
bun run server.ts <directorio> [--port|-p <puerto>]   # puerto por defecto 3000
bun run build                                         # binario en dist/markvi
bun run typecheck
bun test
```

Prueba: `bun run server.ts ./example`

## Estructura

- `server.ts`: entrada única. Parsea CLI, valida, crea el watcher y arranca `Bun.serve`; cierra ambos con `SIGINT`/`SIGTERM`.
- `public/index.html`, `app.ts`, `render.ts`, `style.css`: SPA de lectura, render Markdown y navegación.
- `public/keys.ts`, `public/finder.ts`, `public/fuzzy.ts`, `public/tabstore.ts`, `public/vimui.ts`, `public/lines.ts`: tecla líder, modal buscador, búsqueda difusa, persistencia de pestañas, formato del estado Vim y mapa de líneas del render; `public/*.test.ts`: pruebas Bun.
- `src/api.ts`, `src/files.ts`: API, resolución segura de rutas y escritura/creación; `src/watch.ts`: vigilancia del raíz con `fs.watch` y eventos SSE; `src/*.test.ts`: pruebas Bun.
- `example/`: notas, subdirectorio, imagen y enlaces de ejemplo.

## Servidor (`server.ts`)

- Escucha solo en `127.0.0.1`.
- `root`: ruta real absoluta del directorio explorado. `src/files.ts` lista/resuelve sus archivos.
- `fail(msg)`: imprime error + uso y sale con código 1. Usada para args inválidos, ruta inexistente, puerto no válido o en uso.
- `src/api.ts`: `GET /api/tree`, `GET/PUT /api/file?path=...`, `GET /api/events` (SSE) y `GET /files/*` para estáticos. Protege traversal/symlinks, archivos ocultos y Host.
- `GET /api/file` devuelve `ETag`; `PUT` acepta `If-Match` y responde `409` si el contenido cambió. `PUT ...&create=1` permite recrear un archivo borrado (la carpeta debe existir y seguir dentro del raíz).
- `src/watch.ts` vigila el raíz con `fs.watch({ recursive: true })`, agrupa eventos por ruta y distingue `change`/`delete`. `idleTimeout: 60` mantiene vivo el SSE; hay un latido cada 25 s.
- Rutas en `routes` de `Bun.serve`; `fetch` es el fallback 404.

## Frontend

- `index.html` se importa en `server.ts` (`import index from "./public/index.html"`): Bun empaqueta el TS/CSS que enlaza y lo sirve en `/_bun/*`. No hay paso de build ni carpeta de estáticos servida a mano.
- `app.ts`: índice, pestañas, render de archivo, navegación interna/atrás/adelante bajo `/view/` y modo edición (`a`/`i` entran en modo Normal; aviso en `beforeunload` si hay cambios; conserva scroll y cursor por pestaña). Al entrar desde la vista, `a` coloca el cursor en la línea de lectura (o en la selección) y alinea el editor a la misma altura; al salir, la vista se desplaza al bloque de esa línea. El bloque bajo la línea de referencia se marca con una barra discreta. El botón «Editar» solo entra al editor y se desactiva mientras se edita: la salida es solo por comandos ex.
- Barra inferior de estado (`#status`): modo (`Índice`/`Vista`/`NORMAL`/`INSERT`/`VISUAL`/`V-LINE`/`V-BLOCK`/`REPLACE`), comando pendiente y macro en curso (`recording @q`), estado (`Guardado`/`Sin guardar`/`Conflicto`/`Archivo borrado`/`Error`), mensajes y acciones contextuales.
- Recarga en vivo: `EventSource("/api/events")`. Sin borrador local, la pestaña se recarga y, si está en el editor, se sustituye el documento conservando el cursor. Con borrador, se marca conflicto y la barra ofrece «Recargar»/«Sobrescribir»; si el archivo desaparece, «Recrear archivo»/«Descartar cambios»/«Cerrar pestaña». Los guardados mandan `If-Match` y el editor usa `setDoc` para recargas externas.
- El índice también se refresca solo cuando cambian archivos y está visible.
- Pestañas: una por archivo abierto, con punto de cambios sin guardar y botón de cierre. El buscador abre en pestaña nueva o enfoca la existente; los enlaces internos navegan en la pestaña actual o enfocan su pestaña si ya está abierta. `espacio+←/→` cambia de pestaña y `espacio+x` cierra la activa. Los borradores viven en memoria por pestaña; `localStorage` guarda rutas y modo (no borradores).
- `keys.ts`: tecla líder `espacio` con secuencias. En `app.ts`: `espacio+f` abre el buscador, `espacio+←/→` cambia de pestaña y `espacio+x` cierra la activa. No se activa en campos de texto; en el editor funciona en modo Normal (se intercepta en captura antes de que Vim reciba la tecla).
- `finder.ts`: modal estilo Telescope (buscador centrado, resultados con caracteres resaltados, preview renderizada, flechas/`Ctrl+j`/`Ctrl+k`, `Enter`/`Esc`). Consulta `/api/tree` al abrir y cachea contenidos para el preview.
- `fuzzy.ts`: coincidencia por subsecuencia con puntuación por rachas, inicio de palabra y camelCase; smart case. Sin dependencias.
- `editor.ts`: CodeMirror 6 con `@replit/codemirror-vim` (Normal/Insert/Visual/Replace), resaltado Markdown, ajuste de línea y tema claro/oscuro. `Esc` solo vuelve a Normal. Los comandos ex `:w`, `:wq`, `:x`, `:q`, `:q!`, `ZZ` y `ZQ` viven en `editor.ts` y llaman a `app.ts`; `:q` avisa si hay cambios y nunca cierra la pestaña. `:set` soporta `number` (por defecto), `relativenumber` y `scrolloff`. `j`/`k` usan líneas de pantalla (`gj`/`gk`) en Normal y Visual. La grabación de macros se muestra en la barra inferior y el panel propio de la librería se oculta. `setDoc` permite recargas externas sin recrear la vista.
- `vimui.ts`: funciones puras que traducen el modo de Vim y componen el texto de comando pendiente/macro para la barra de estado.
- `render.ts`: Marked + marked-highlight/highlight.js, sanitización DOMPurify, checkboxes, IDs y URLs relativas (`/view/` Markdown, `/files/` estáticos). Anota cada bloque con `data-line`/`data-end-line` a partir de una única pasada del lexer; `lines.ts` convierte esa geometría en la línea de lectura.
- El estado de pestañas y edición vive en `app.ts` (`Tab`, `tabs`, `active`, borradores por pestaña); `editor.ts` solo expone la vista de CodeMirror. `tabstore.ts` valida y serializa lo persistido en `localStorage`.
- CSP `sandbox` y `nosniff` en `/files/*`; los archivos se comparten en el origen de la app.
- Tema claro/oscuro por `prefers-color-scheme`; sin framework.

## Convenciones

- Mensajes y UI en español.
- TypeScript estricto (`tsconfig.json` de `bun init`).
