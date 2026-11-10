# CONTEXT

Visor/editor local de Markdown con Bun. Plan y fases en `TODO.md`. Mantener este archivo breve y actualizarlo al cerrar cada fase.

## Estado

Fases 0–3 hechas. Siguiente: Fase 4 (buscador de archivos).

## Uso

```sh
bun run server.ts <directorio> [--port|-p <puerto>]   # puerto por defecto 3000
bun run typecheck
bun test
```

Prueba: `bun run server.ts ./example`

## Estructura

- `server.ts`: entrada única. Parsea CLI, valida y arranca `Bun.serve`.
- `public/index.html`, `app.ts`, `render.ts`, `style.css`: SPA de lectura, render Markdown y navegación.
- `src/api.ts`, `src/files.ts`: API y resolución segura de rutas; `src/*.test.ts`: pruebas Bun.
- `example/`: notas, subdirectorio, imagen y enlaces de ejemplo.

## Servidor (`server.ts`)

- Escucha solo en `127.0.0.1`.
- `root`: ruta real absoluta del directorio explorado. `src/files.ts` lista/resuelve sus archivos.
- `fail(msg)`: imprime error + uso y sale con código 1. Usada para args inválidos, ruta inexistente, puerto no válido o en uso.
- `src/api.ts`: `GET /api/tree`, `GET/PUT /api/file?path=...`, `GET /files/*` para estáticos. Protege traversal/symlinks, archivos ocultos y Host.
- Rutas en `routes` de `Bun.serve`; `fetch` es el fallback 404.

## Frontend

- `index.html` se importa en `server.ts` (`import index from "./public/index.html"`): Bun empaqueta el TS/CSS que enlaza y lo sirve en `/_bun/*`. No hay paso de build ni carpeta de estáticos servida a mano.
- `app.ts`: índice, render de archivo, navegación interna/atrás/adelante bajo `/view/` y modo edición (`e` entra; `Esc` guarda y sale; `Ctrl+S` guarda; aviso en `beforeunload` si hay cambios; conserva scroll y cursor por archivo). El botón «Editar» se desactiva en el índice y en páginas con error.
- `editor.ts`: CodeMirror 6 con resaltado Markdown, números de línea, ajuste de línea y tema claro/oscuro. `Esc`/`Mod-s` van en un `keymap` de alta prioridad.
- `render.ts`: Marked + marked-highlight/highlight.js, sanitización DOMPurify, checkboxes, IDs y URLs relativas (`/view/` Markdown, `/files/` estáticos).
- El estado de edición vive en `app.ts` (`rawDocument`, `draft`, `dirty`, `positions`); `editor.ts` solo expone la vista de CodeMirror.
- CSP `sandbox` y `nosniff` en `/files/*`; los archivos se comparten en el origen de la app.
- Tema claro/oscuro por `prefers-color-scheme`; sin framework.

## Convenciones

- Mensajes y UI en español.
- TypeScript estricto (`tsconfig.json` de `bun init`).
