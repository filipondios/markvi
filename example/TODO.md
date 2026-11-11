# TODO: MarkVi

Visor y editor local de Markdown con Bun. Navegas un directorio de archivos `.md`, los lees renderizados y los editas con teclado estilo Vim/Neovim.

## Estado

Fases 0 a 7b hechas. Siguiente: navegación Vim en la vista renderizada (Fase 8).

## Fases 0 a 7 (hechas)

- **Fase 0, esqueleto:** Bun, `server.ts` en `127.0.0.1`, ruta del directorio como argumento, `--port`.
- **Fase 1, API:** árbol de archivos, lectura y guardado con `ETag`/`If-Match`, protección contra path traversal, estáticos relativos.
- **Fase 2, render:** `marked` + `DOMPurify`, resaltado de código, casillas, enlaces relativos, tema claro/oscuro.
- **Fase 3, edición:** CodeMirror 6 con resaltado de Markdown, `e` para entrar, `Esc` para guardar y salir.
- **Fase 4, buscador:** tecla líder `espacio`, modal tipo Telescope con búsqueda difusa y preview.
- **Fase 5, pestañas:** barra de pestañas, `espacio + ←/→` (sustituido por `gt` / `gT`, Fase 8), `espacio + x`, persistencia en `localStorage`.
- **Fase 6, pulido:** recarga por `fs.watch` + SSE, conflictos al guardar, barra de estado, binario con `bun build --compile`.
- **Fase 7, edición Vim pura:** `@replit/codemirror-vim`, modos Normal/Insert/Visual/Replace, salida solo con comandos ex (`:w`, `:wq`, `:x`, `ZZ`, `:q`, `:q!`, `ZQ`), `:set` básico, líder dentro del editor y estado de Vim en la barra inferior.

---

## Decisiones tomadas

1. **Directorio:** se pasa como argumento al arrancar.
2. **Dependencias:** se permiten librerías.
3. **Edición:** pura estilo Vim, no opcional. Esto sustituye a las decisiones anteriores de `Esc` guarda y sale, y de atajos globales solo en la vista renderizada.
4. **Tabla de contenidos:** no se muestra en la UI. Solo el documento, más un menú tipo Telescope bajo demanda.
5. **Vista dividida:** descartada. Nunca editor y render lado a lado.
6. **Atajos:** todos pasan a estilo Vim. La tecla líder `espacio` se mantiene, como en Neovim.
7. **UI:** rediseño visual de todo lo que no sea el Markdown renderizado ni el código, que se quedan como están.
8. **Entrar al editor:** con `a` en lugar de `e`.
9. **Posición de lectura:** al entrar al editor, el cursor aparece donde el usuario va leyendo y no al principio del archivo (ver Fase 7b).
10. **Salir del editor:** solo con comandos de Vim (`:wq`, `:x`, `ZZ`, `:q`, `:q!`). `Esc` deja de guardar y salir: solo vuelve a modo Normal.
11. **Pestañas:** `gt` / `gT`. Desaparecen `espacio + ←/→`. `espacio + x` para cerrar pestaña se mantiene.
12. **Menú de TOC:** `espacio + t`, con preview de la sección.
13. **Tipografía de la interfaz:** Obel Mono 1.003 (licencia OFL 1.1, verificada) autoalojada desde el zip, con Cascadia Code / Roboto Mono solo como reserva. Aplica al chrome y al editor de CodeMirror, no al Markdown renderizado ni a sus bloques de código.
14. **Al pulsar `a` en la vista:** el editor abre en modo Normal, no en Insert. Para escribir hay que pulsar `a` (o `i`, `o`...) otra vez ya dentro del editor.
15. **Fuente del editor:** Obel Mono también en el editor de CodeMirror, además del chrome. Los bloques de código del Markdown renderizado no cambian.
16. **`:q` en el editor:** solo cierra el modo edición y vuelve a la vista de la misma pestaña. Nunca cierra la pestaña.
17. **Fuente en el repo:** el zip `ObelMono-1.003.zip` está en la raíz del proyecto. De él se copia solo el WOFF2 necesario a `public/fonts/`.
18. **Líneas ajustadas:** `j` / `k` se mapean a `gj` / `gk` en Normal y Visual, porque el ajuste de línea está activo. Con operador (`dj`, `yk`) siguen siendo líneas lógicas del archivo.
19. **Registro por defecto:** interno del editor, no el portapapeles del sistema. Pegar o copiar entre aplicaciones queda para una fase posterior.
20. **`:set` básico:** `number` activo por defecto, `relativenumber` desactivado y `scrolloff` a `0`. Se aceptan `nu`/`rnu`/`so=N` y sus formas `no…`.

## Descartado

- Modo Vim opcional: ahora es el único modo.
- Vista dividida editor + render.
- Tabla de contenidos fija en la interfaz.
- Botón «Editar» como vía principal (se conserva el atajo de teclado).
- La tecla `e` para entrar al editor: la sustituye `a`.
- `Esc` para guardar y salir del editor: se sale con `:wq`, `:x`, `ZZ` o `:q`.
- `Ctrl+S` como guardado rápido: se guarda solo con comandos ex (`:w`, `:wq`, `:x`, `ZZ`).
- `espacio + ←/→` para cambiar de pestaña: lo sustituyen `gt` / `gT`.
- `espacio + o` como atajo del TOC: se usa `espacio + t`.
- Abrir el editor directamente en Insert al pulsar `a`.
- Una «línea virtual» que baja cada x desplazamientos: se desfasa porque la altura renderizada no es proporcional a las líneas del archivo. Se sustituye por el cálculo desde la geometría real (Fase 7b).

---

## Fase 7: Edición Vim pura

- [x] Añadir `@replit/codemirror-vim` y sustituir `defaultKeymap` en `public/editor.ts`
- [x] Mantener `history()` (lo usan `u` y `Ctrl-r`)
- [x] `a` (con `i` como alias) abre el editor en **modo Normal**. Para escribir se vuelve a pulsar `a` / `i` / `o` ya dentro del editor, como en Vim. Por ahora usa la última posición del cursor; la posición de lectura es la Fase 7b
- [x] Quitar el `Escape` → `onExit` del `keymap` de `public/editor.ts`, que hoy guarda y sale, y revisar `exitEditor` en `app.ts` para que lo llamen solo los comandos ex
- [x] Modos disponibles: Normal, Insert, Visual (`v`, `V`, `Ctrl-v`) y Replace
- [x] `Esc` en Insert o Visual vuelve a Normal y **nunca guarda ni sale del editor**. En Normal solo cancela lo pendiente
- [x] Salir **solo** con comandos ex (`Vim.defineEx`) y sus atajos:
  - `:w` guarda sin salir
  - `:wq`, `:x` y `ZZ` guardan y salen
  - `:q` sale si no hay cambios; con cambios muestra el aviso estilo Vim («No se guardó desde el último cambio, añade ! para forzar») y no sale
  - `:q!` y `ZQ` descartan los cambios y salen
- [x] «Salir» significa volver a la vista renderizada de la misma pestaña (el editor es un modo de la pestaña). `:q` en el editor **nunca** cierra la pestaña. Para cerrarla se usa `espacio + x`, y en la vista `:q` (Fase 8)
- [x] Guardado solo con comandos ex (`:w`, `:wq`, `:x`, `ZZ`); sin atajos tipo `Ctrl+S`
- [x] La tecla líder funciona también en modo Normal del editor (`espacio + f`, `espacio + o`, pestañas). Se intercepta en captura en `app.ts` y se puentea hacia `leader`
- [x] Indicador de modo en la barra de estado: NORMAL, INSERT, VISUAL, V-LINE, V-BLOCK, REPLACE
- [x] Mostrar el comando pendiente (`d`, `2`, `"a`) y la grabación de macros (`recording @q`)
- [x] Integrar la línea `:` y la búsqueda `/` `?` con el estilo de la barra inferior (revisar cómo las presenta la librería)
- [x] Líneas largas ajustadas: `j`/`k` se mapean a `gj`/`gk` en Normal y Visual (decisión 18)
- [x] Opciones al estilo `:set`: `number`, `relativenumber` y `scrolloff` (decisión 20)
- [x] Decidir si el registro por defecto es el portapapeles del sistema: no, queda interno (decisión 19)
- [x] Documentar la limitación de atajos reservados por el navegador (`Ctrl+W`, `Ctrl+T`, `Ctrl+N`): no se pueden usar como en Vim
- [x] Pruebas: `a` abre en Normal, `Esc` no sale del editor, `:wq` guarda y sale, `:q` con cambios no sale, `:q!` descarta, la líder funciona en Normal
- [x] Actualizar la tabla de atajos del `README.md` y `CONTEXT.md`

## Fase 7b: Posición de lectura (vista ↔ editor)

**Problema:** hoy el editor se abre con `tab.cursor`, la última posición del propio editor, y el scroll de la vista nunca se convierte en una línea del archivo. En un archivo largo hay que bajar a mano hasta la sección.

**Enfoque:** calcular la línea desde la geometría real de la página, no contando desplazamientos. No guarda estado y funciona igual con rueda, barra de scroll, teclado, enlaces a secciones o cambios de tamaño.

- [x] **Mapa de líneas:** al renderizar, marcar cada bloque (encabezado, párrafo, lista y sus elementos, cita, código, tabla, `hr`) con `data-line` y `data-end-line`. Se calculan acumulando el `raw` de los tokens del lexer de `marked`, antes de `DOMPurify`, que conserva los atributos `data-*` por defecto (comprobarlo)
- [x] En citas el `raw` pierde los `>`, así que dentro de ellas la línea puede ser aproximada: usar la del inicio de la cita o corregirlo
- [x] **Línea de referencia:** un punto fijo del viewport, en torno al 30 % desde el borde superior del contenido, descontando la barra fija. El bloque que la cruza es el **bloque actual**
- [x] **Interpolar** dentro de bloques largos (código, tablas, párrafos): la fracción ya recorrida del bloque da la línea exacta de su rango
- [x] Casos límite: arriba del todo es el primer bloque, abajo del todo el último, y un bloque sin mapa (HTML embebido) usa el anterior con mapa
- [x] Una sola función `currentSourceLine()`, reutilizable por `a`, por el TOC (Fase 9) y por la barra de estado
- [x] **Al pulsar `a`:** cursor en esa línea (primer carácter no blanco) y desplazamiento para que quede a la misma altura de pantalla que tenía el bloque en la vista, así el contenido no «salta»
- [x] La posición de lectura prevalece sobre `tab.cursor` (el cursor guardado de la última edición)
- [x] Si hay texto seleccionado en la vista, buscarlo dentro del rango fuente del bloque y colocar el cursor ahí. Si no se encuentra, inicio de línea
- [x] **Al salir del editor:** camino inverso. La vista se desplaza hasta el bloque que contiene la línea del cursor, en lugar de restaurar el scroll antiguo
- [x] **Indicador discreto** del bloque actual: barra fina de acento en el margen izquierdo, con poca opacidad, sin tocar los estilos del Markdown. En pantallas estrechas, fondo tenue en lugar de barra. Desactivable desde la configuración (Fase 11)
- [ ] Barra de estado en la vista: línea actual, por ejemplo `ln 142/310` (Fase 10)
- [ ] `j` / `k` (Fase 8) mueven el bloque actual de uno en uno y desplazan la vista para mantenerlo cerca de la línea de referencia. Con la rueda o la barra de scroll, el bloque actual sigue a la línea de referencia
- [ ] Opcional: doble clic en un bloque abre el editor en ese punto
- [x] Pruebas: función pura (mapa de bloques + `top` de cada uno → línea) con casos de arriba, abajo, bloque largo y bloque sin mapa. Pruebas del cálculo de líneas con listas anidadas, citas, front matter y finales de línea CRLF

## Fase 8: Navegación Vim en la vista renderizada

- [ ] `j` / `k` mueven el bloque actual (ver Fase 7b), `Ctrl-d` / `Ctrl-u` para media página, `gg` / `G` para inicio y final
- [ ] Prefijos numéricos (`5j`) y tecla pendiente visible en la barra de estado
- [ ] `]]` / `[[` para saltar al encabezado siguiente o anterior
- [ ] `/` para buscar dentro del documento renderizado, con `n` / `N` y coincidencias resaltadas (el `Ctrl+F` del navegador no encaja con el flujo)
- [ ] `f` para seguir enlaces con etiquetas de teclas (hint mode, como Vimium)
- [ ] Pestañas con `gt` / `gT`, y `{n}gt` para ir a la pestaña n. Eliminar `espacio + ←/→` del código y de la tabla de atajos del `README.md`. `espacio + x` se mantiene
- [ ] `gt` / `gT` también funcionan desde modo Normal del editor (Fase 7), registrados con `Vim.map`
- [ ] Atrás y adelante entre documentos con `Ctrl-o` / `Ctrl-i` (la navegación por historial ya existe)
- [ ] `:` también en la vista: `:e archivo`, `:q` cierra la pestaña, `:w`

## Fase 9: Menú de índice (TOC) estilo Telescope

- [ ] Generalizar `public/finder.ts` en un selector genérico: fuente de elementos, preview opcional y acción al elegir. Ya recibe `list`, `read` y `open`, así que el cambio es pequeño
- [ ] Atajo `espacio + t` (table of contents), registrado en la tecla líder y en el which-key
- [ ] Extraer los encabezados con el lexer de `marked`, para ignorar los que están dentro de bloques de código e incluir los setext
- [ ] Mostrar niveles h1–h6 con sangría y marca visual por nivel
- [ ] Búsqueda difusa sobre los títulos reutilizando `fuzzy.ts`, con coincidencias resaltadas
- [ ] La selección inicial es el encabezado actual según el scroll (misma función de bloque actual de la Fase 7b)
- [ ] `Enter` en la vista desplaza hasta el encabezado (los IDs ya los genera `render.ts`)
- [ ] `Enter` en el editor mueve el cursor a la línea del encabezado (requiere la línea de origen del token)
- [ ] Funciona desde la vista y desde modo Normal del editor
- [ ] Documento sin encabezados: mensaje de estado vacío
- [ ] **Preview de la sección** del encabezado seleccionado, con el mismo diseño que el buscador de archivos (lista a un lado, preview al otro)
- [ ] El preview renderiza con `renderMarkdown` el contenido desde ese encabezado hasta el siguiente de igual o mayor nivel
- [ ] Limitar la altura o el número de líneas del preview en secciones muy largas, y cachear el render por encabezado
- [ ] Mismos retrasos de preview (`PREVIEW_DELAY`) y navegación (flechas, `Ctrl+j` / `Ctrl+k`) que el buscador, para que ambos se sientan iguales

## Fase 10: Rediseño de la UI

**Alcance:** barra superior, pestañas, barra de estado, selector modal, pantalla de índice y estados de error o conflicto. El Markdown renderizado y los bloques de código no se tocan.

**Sobre las referencias:**
- `flawless-ui-ux` es la guía principal. Sus ideas aplican directamente: dirección visual a partir del producto, roles de color, tipografía probada con contenido real, accesibilidad, estados, y una revisión final contra patrones genéricos.
- `benjitaylor/skills` solo contiene **Stageshow**, orientado a ilustraciones de interfaz falsa y demos animadas para páginas de marketing. No es una guía general de UI. Se aprovechan sus ideas de contención y detalle (decir las cosas una vez, insets de 12 px, separación de 8 a 12 px entre controles, una sola familia tipográfica, sin esquinas muertas). También sirve para una futura demo del README.

**Dirección:**
- [ ] Chrome mínimo y pensado para teclado: el documento lidera, la interfaz acompaña
- [ ] Definir roles de color (superficie, texto, énfasis, estado) ampliando `:root` en ambos temas
- [ ] Un acento principal, más un color por modo Vim en la barra de estado (Normal, Insert, Visual)
- [ ] **Tipografía del chrome: Obel Mono**, autoalojada para que funcione sin red. Se aplica a pestañas, barra de estado, selectores, which-key, línea `:` y al editor de CodeMirror. El Markdown renderizado y sus bloques de código no cambian
- [ ] Extraer del zip de la raíz (`ObelMono-1.003.zip`) y copiar a `public/fonts/` **solo** `ObelMono/woff2/ObelMono-VF.woff2` (Roman variable, 144 KB, eje de peso 100–900), más `OFL.txt` y `AUTHORS.txt`. No copiar la cursiva (158 KB), la versión Masked ni los TTF/OTF: el zip completo ocupa 22 MB descomprimido
- [ ] `@font-face` partiendo del `obel-mono.css` del zip (ya trae `font-weight: 100 900` y `font-display: swap`), quitando el bloque de cursiva y ajustando la ruta del `url()`. Pila de reserva: `"Obel Mono", ui-monospace, "Cascadia Code", "Roboto Mono", monospace`
- [ ] Pesos previstos para el chrome: 400 en texto normal, 500 para pestaña activa y 600 para la píldora de modo. Al ser variable, no hace falta un archivo por peso
- [ ] **Editor:** en `public/editor.ts`, sustituir el `fontFamily` fijo (`ui-monospace, SFMono-Regular, ...`) por la misma pila de Obel Mono, mejor mediante una variable CSS compartida (`--font-mono`). Revisar `lineHeight`, la sangría de `lineWrapping` y el ancho de los números de línea con el nuevo tamaño de carácter (0,6 em)
- [ ] Los bloques de código del render (`pre`, `code` en `style.css`) mantienen su pila actual, así que no deben usar `--font-mono`
- [ ] El zip pesa 11 MB: añadirlo al `.gitignore` o moverlo fuera del repo una vez copiado el WOFF2, para no versionarlo. Si se quiere conservarlo, que sea una decisión explícita. El `OFL.txt` y `AUTHORS.txt` sí se versionan junto a la fuente
- [ ] No activar `ss01` (es el enmascarado de claves). `cv01`–`cv16` y `ss02` son variantes opcionales: no usarlas salvo que una prueba visual lo justifique
- [ ] Comprobar sin red: que `bun run` y el binario de `bun build --compile` sirven la fuente (que Bun empaqueta el `url()` del CSS) y que DevTools no muestra peticiones externas
- [x] **Licencia verificada en el `OFL.txt` del zip** (SIL OFL 1.1, © 2026 The Obel Mono Project Authors, autor Cody Collier): permite usar, estudiar, modificar y redistribuir la fuente, incrustarla en software y publicarla, siempre que no se venda por sí sola. La cabecera no declara ningún «Reserved Font Name»
- [ ] Cumplir la licencia: mantener `OFL.txt` y el copyright junto a la fuente en el repo y en el binario compilado (por ejemplo, mencionarla en una sección «Licencias» del `README.md`). Si en algún momento se modifica la fuente (subconjunto de glifos, conversión), seguirá bajo OFL
- [x] **Cobertura comprobada** en la TTF variable: `áéíóúñüÁÉÍÓÚÑÜ ¿¡ — « » € → ← ✓ ● ⚠ …` están todos. Ancho de avance de 1200/2000 = 0,6 em, y sin ligaduras (no hay `liga` en `GSUB`)
- [ ] La comprobación de glifos se hizo en la TTF. Repetirla en el WOFF2 en el navegador (un archivo de prueba con esos caracteres) cuando se integre
- [ ] Probar con contenido real (nombres de archivo largos, `línea:columna`, mensajes de estado). Cambiar a Cascadia Code o Roboto Mono solo si Obel Mono falla ahí
- [ ] Al ser monoespaciada (0,6 em por carácter), `línea:columna` y los contadores ya alinean. Vigilar el ancho fijo para que la barra de estado no salte al cambiar de modo
- [ ] Radios, bordes y sombras coherentes en todas las piezas

**Piezas:**
- [ ] **Pestañas** estilo bufferline: indicador de pestaña activa, punto de cambios sin guardar, cierre al pasar el ratón, desbordamiento con scroll, desambiguar nombres iguales mostrando la carpeta
- [ ] **Barra de estado** estilo lualine: píldora de modo, ruta, indicador de cambios, `línea:columna`, mensajes y acciones de conflicto, sin saltos de ancho
- [ ] **Barra superior**: quitar el botón «Editar» (redundante con `a`) y reducir la marca `markvi`
- [ ] **Selector modal** (buscador y TOC): fondo atenuado, contenedor con separación clara entre lista y preview, fila seleccionada visible, contador de resultados, pie con pistas de teclas, estado vacío
- [ ] **Which-key**: al pulsar `espacio` y esperar ~300 ms, panel pequeño con las continuaciones disponibles, generado desde las acciones de `keys.ts`
- [ ] **Pantalla de índice**: archivos agrupados por carpeta, recientes y pista de atajos; estado vacío cuando no hay archivos
- [ ] **Estados**: cargando, archivo no encontrado, error de guardado y conflicto, siempre con una acción de recuperación

**Calidad:**
- [ ] `:focus-visible` en todos los controles, objetivos de al menos 24×24 px
- [ ] Contraste medido contra los fondos reales: 4.5:1 para texto y 3:1 para controles, en claro y oscuro
- [ ] Modal con foco atrapado y devuelto al cerrar, y roles ARIA coherentes (`tablist`, `dialog`)
- [ ] Transiciones de 120 a 160 ms en modal y pestañas, respetando `prefers-reduced-motion`
- [ ] Responsive de 320 a 1280 px: pestañas con scroll y barra de estado que colapsa
- [ ] Revisión final: capturas en claro y oscuro a tres anchos, sin tarjetas repetidas ni iconos decorativos

**Proceso:**
- [ ] Instalar la skill en el repo (`bunx flawless-ui-ux@latest install --claude-code`, requiere Node 22.12+)
- [ ] Pedir el rediseño indicando explícitamente que se preserve el Markdown renderizado, el código y el comportamiento
- [ ] Usar su CLI de inspección para obtener evidencias antes y después

---

## Fase 11: Otras mejoras propuestas

**Prioridad alta**
- [ ] **Casillas interactivas en la vista**: marcar o desmarcar una tarea escribe el cambio en el archivo (`- [ ]` ↔ `- [x]`), usando el `ETag` ya existente. Encaja con el origen de la app, que era organizar un `TODO.md`. Un atajo (`x`) para la tarea seleccionada y un contador `12/20` en la barra de estado
- [ ] **Crear, renombrar y borrar archivos** desde `:`: `:e nuevo.md`, `:mv`, `:rm` con confirmación. Y crear desde el buscador cuando no hay coincidencias
- [ ] **Búsqueda de texto completo** (`espacio + /`, tipo live grep) con preview que salta a la línea
- [ ] **Archivos recientes** (`espacio + r`) y alternar con el archivo anterior (`Ctrl-^`)

**Prioridad media**
- [ ] **Configuración** en un archivo (`keymap`, líder, tema, fuente, `relativenumber`), por ejemplo en `~/.config/markvi/`. Antes era una idea de futuro y con el modo Vim gana mucho valor
- [ ] Enlaces `[[wiki]]` y backlinks
- [ ] Buscador: ordenar por recientes y virtualizar la lista en directorios grandes
- [ ] Extras de render opcionales, hoy no soportados: notas al pie, alertas `> [!NOTE]` y front matter

**Prioridad baja**
- [ ] Hoja de estilos de impresión (`@media print`), así `Ctrl+P` genera el PDF sin dependencias
- [ ] Demo animada o capturas para el README (Stageshow encaja aquí)


## Orden recomendado

`7 → 7b → 9 → 10 → 8 → 11`

- La Fase 7 cambia la arquitectura de teclas (modos y líder dentro del editor), así que va primero.
- La 7b va justo después: sin ella `a` abriría el editor al principio del archivo, y la 9 reutiliza su función de bloque actual.
- La 9 reutiliza el buscador y es pequeña una vez generalizado.
- La 10 necesita el modo Vim y el `línea:columna` para la barra de estado y el which-key.
- La 8 y la 11 se pueden ir intercalando por prioridad.
