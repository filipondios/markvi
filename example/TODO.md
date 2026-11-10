# TODO: Visor/editor de Markdown con Bun

App local para navegar, renderizar y editar archivos `.md` de un directorio, con atajos de teclado estilo Neovim.

## Decisiones técnicas (propuestas)

- **Runtime/servidor:** Bun (`Bun.serve`), escuchando solo en `127.0.0.1`
- **Frontend:** un único HTML + JS, sin framework
- **Render markdown:** `marked` (o `Bun.markdown`) + `DOMPurify` para sanitizar
- **Editor con colores:** CodeMirror 6 (resaltado de markdown y bloques de código)
- **Directorio raíz:** se pasa por argumento (`bun run server.ts ./mis-notas`)

---

## Fase 0: Esqueleto del proyecto

- [x] Crear el proyecto (`bun init`) y estructura de carpetas
- [x] `server.ts` con `Bun.serve` en `127.0.0.1`
- [x] Argumento de CLI obligatorio con la ruta del directorio a explorar (`bun run server.ts ./mis-notas`)
- [x] Validar que la ruta existe y es un directorio (error claro si no)
- [x] Opcional: puerto configurable con `--port`
- [x] Servir un `index.html` base
- [x] Crear un `TODO.md` de ejemplo en el directorio raíz para probar

## Fase 1: API del servidor

- [x] `GET /api/tree`: lista recursiva de archivos `.md`
- [x] `GET /api/file?path=...`: devuelve el contenido crudo
- [x] `PUT /api/file?path=...`: guarda cambios
- [x] Protección contra path traversal (normalizar y comprobar que la ruta queda dentro del raíz)
- [x] Ignorar `node_modules`, `.git` y carpetas ocultas
- [x] Servir imágenes y estáticos relativos a cada `.md`

## Fase 2: Renderizado

- [x] Renderizar markdown a HTML en el cliente
- [x] Sanitizar el HTML resultante
- [x] Estilos legibles (tipografía, tablas, citas, código)
- [x] Resaltado de sintaxis en bloques de código del render
- [x] Soporte de checkboxes `- [ ]` / `- [x]`
- [x] Reescribir enlaces relativos entre `.md` para que abran dentro de la app
- [x] Tema claro/oscuro (siguiendo el del sistema)

## Fase 3: Modo edición (tecla `e`)

- [x] En la vista renderizada, `e` entra al editor
- [x] En el editor, `Esc` guarda y vuelve a la vista renderizada (`e` es texto normal ahí)
- [x] Integrar CodeMirror 6 con resaltado de markdown
- [x] Guardar con `Ctrl+S` (sin salir del editor) y al pulsar `Esc`
- [x] Indicador de cambios sin guardar (para el caso de cerrar pestaña o recargar sin pasar por `Esc`)
- [x] Avisar antes de cerrar una pestaña con cambios sin guardar
- [x] Conservar posición del scroll/cursor al cambiar de modo
- [x] Atajos globales (`espacio+f`, `espacio+←/→`) solo activos en la vista renderizada, no dentro del editor

## Fase 4: Buscador de archivos (`espacio + f`, estilo Telescope)

- [x] Sistema de "tecla líder" (`espacio`) con secuencias de teclas
- [x] Modal centrado con campo de búsqueda
- [x] Búsqueda difusa (fuzzy) sobre la lista de archivos
- [x] Navegar resultados con flechas / `Ctrl+j` / `Ctrl+k`
- [x] Panel de preview del archivo seleccionado (render o texto)
- [x] `Enter` abre el archivo, `Esc` cierra el modal
- [x] Resaltar en los resultados los caracteres que coinciden

## Fase 5: Pestañas

- [ ] Barra de pestañas (una por archivo abierto)
- [ ] Abrir archivo desde el buscador en una pestaña nueva (o enfocar la existente)
- [ ] `espacio + →` / `espacio + ←` para cambiar de pestaña
- [ ] Cerrar pestaña (por ejemplo `espacio + x`)
- [ ] Recordar pestañas abiertas entre sesiones (`localStorage`)
- [ ] Mantener el modo (render/edición) por pestaña

## Fase 6: Pulido

- [ ] Recarga automática si el archivo cambia en disco (`fs.watch` + SSE/WebSocket)
- [ ] Manejo de errores (archivo borrado, sin permisos, conflicto al guardar)
- [ ] Mensajes de estado en una barra inferior (guardado, error, modo actual)
- [ ] Empaquetar como comando (`bun build --compile` o script en el PATH)

---

## Futuro / ideas posteriores

- [ ] **Atajos personalizables** mediante un archivo de configuración (por ejemplo `keymap.json`)
- [ ] Crear, renombrar y borrar archivos desde la app
- [ ] Búsqueda de texto completo en el contenido (tipo `live grep`)
- [ ] Modo Vim opcional en el editor (`@replit/codemirror-vim`)
- [ ] Vista dividida: editor y render lado a lado
- [ ] Índice/tabla de contenidos del documento actual
- [ ] Backlinks y enlaces tipo `[[wiki]]`
- [ ] Exportar a PDF/HTML

---

## Decisiones tomadas

1. **Teclas en modo edición:** `e` entra al editor desde la vista renderizada y `Esc` sale de él. Dentro del editor `e` y `espacio` son texto normal.
2. **Guardado:** con `Ctrl+S` y automáticamente al pulsar `Esc`.
3. **Alcance:** el directorio raíz se pasa como argumento al arrancar la app.
4. **Dependencias:** se permiten librerías (`marked`, `DOMPurify`, CodeMirror 6, un buscador fuzzy como `fuse.js` o `fzf-for-js`).
5. **Buscador:** tecla líder `espacio` + `f`; búsqueda difusa propia (sin dependencia extra), preview renderizado, `Enter` abre y `Esc` cierra. `espacio + ←/→` sigue cambiando de archivo desde el índice.

---

## Orden recomendado

`Fase 0 → 1 → 2 → 3` da una app útil (navegar, ver y editar). Las fases `4` y `5` añaden la comodidad estilo Neovim, y la `6` el pulido.
