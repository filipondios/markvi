# Test visual de Markdown

Este archivo sirve para comprobar que el **renderizado** y el **editor con colores** funcionan con todos los elementos habituales. Prueba a pulsar `e` para editar y `Esc` para volver.

---

## 1. Encabezados

# H1: Título de nivel 1
## H2: Título de nivel 2
### H3: Título de nivel 3
#### H4: Título de nivel 4
##### H5: Título de nivel 5
###### H6: Título de nivel 6

Encabezado alternativo (setext) nivel 1
=======================================

Encabezado alternativo (setext) nivel 2
---------------------------------------

---

## 2. Formato de texto

Texto normal con **negrita**, *cursiva*, ***negrita y cursiva***, ~~tachado~~ y `código en línea`.

También se puede usar __negrita con guiones bajos__ y _cursiva con guiones bajos_.

Un párrafo con un salto de línea forzado al final de esta línea  
y esta línea continúa justo debajo.

Un párrafo muy largo para comprobar el ajuste de línea: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

Caracteres especiales y acentos: áéíóú ñ ü ¿¡? — «comillas» € © ™ → ← ✓

Escapes: \*esto no es cursiva\*, \# esto no es un título, \`esto no es código\`.

Emoji: 🚀 ✅ ⚠️ 📝 🎉

HTML en línea: H<sub>2</sub>O, x<sup>2</sup>, <kbd>Ctrl</kbd> + <kbd>S</kbd>, <mark>texto resaltado</mark>.

---

## 3. Listas

### Lista sin orden

- Elemento uno
- Elemento dos
  - Subelemento 2.1
  - Subelemento 2.2
    - Sub-subelemento 2.2.1
- Elemento tres

* Con asteriscos
* En lugar de guiones

### Lista ordenada

1. Primero
2. Segundo
   1. Sub-paso 2.1
   2. Sub-paso 2.2
3. Tercero

### Lista mixta

1. Paso uno
   - Detalle A
   - Detalle B
2. Paso dos
   - Detalle C

### Lista con párrafos

- Primer elemento con un párrafo largo que ocupa varias líneas para ver cómo se alinea el texto cuando hay mucho contenido dentro de un mismo elemento de la lista.

- Segundo elemento separado por línea en blanco.

  Con un segundo párrafo dentro del mismo elemento.

### Lista de tareas

- [x] Tarea completada
- [x] Otra tarea completada
- [ ] Tarea pendiente
- [ ] Otra tarea pendiente
  - [x] Subtarea hecha
  - [ ] Subtarea pendiente

---

## 4. Enlaces e imágenes

- Enlace normal: [Sitio de Bun](https://bun.sh)
- Enlace con título: [Sitio de Bun](https://bun.sh "Runtime de JavaScript")
- Enlace automático: <https://example.com>
- URL suelta: https://example.com/ruta/larga
- Enlace por referencia: [CommonMark][cm]
- Enlace relativo a otro archivo: [Ir al TODO](TODO.md)
- Enlace a un archivo que no existe: [Archivo inexistente](no-existe.md)
- Enlace a una sección de este documento: [Ir a las tablas](#5-tablas)

[cm]: https://commonmark.org

Imagen embebida (SVG en base64, no necesita archivo externo):

![Cuadrado de prueba](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAiIGhlaWdodD0iNjAiPjxyZWN0IHdpZHRoPSIxNjAiIGhlaWdodD0iNjAiIHJ4PSI4IiBmaWxsPSIjNGY0NmU1Ii8+PHRleHQgeD0iODAiIHk9IjM2IiBmb250LXNpemU9IjE4IiBmaWxsPSJ3aGl0ZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9InNhbnMtc2VyaWYiPkltYWdlbiBPSzwvdGV4dD48L3N2Zz4=)

Imagen que no existe (debe mostrar el texto alternativo):

![Imagen rota de prueba](imagenes/no-existe.png)

---

## 5. Tablas

| Columna izquierda | Columna centrada | Columna derecha |
|:------------------|:----------------:|----------------:|
| Texto             | Texto            |               1 |
| Más texto         | Más texto        |              20 |
| Aún más texto     | Aún más texto    |             300 |

Tabla con formato dentro de las celdas:

| Elemento     | Ejemplo               | Resultado |
|--------------|-----------------------|-----------|
| Negrita      | `**texto**`           | **texto** |
| Cursiva      | `*texto*`             | *texto*   |
| Código       | `` `texto` ``         | `texto`   |
| Enlace       | `[a](https://b.com)`  | [a](https://b.com) |

Tabla ancha para probar el desbordamiento horizontal:

| Col 1 | Col 2 | Col 3 | Col 4 | Col 5 | Col 6 | Col 7 | Col 8 | Col 9 | Col 10 |
|-------|-------|-------|-------|-------|-------|-------|-------|-------|--------|
| Dato muy largo número uno | Dato muy largo número dos | Dato muy largo número tres | Dato muy largo número cuatro | Dato muy largo número cinco | Dato muy largo número seis | Dato muy largo número siete | Dato muy largo número ocho | Dato muy largo número nueve | Dato muy largo número diez |

---

## 6. Citas

> Una cita sencilla de una sola línea.

> Una cita más larga que ocupa varias líneas para comprobar
> cómo se renderiza el bloque completo y el borde lateral
> cuando el texto se extiende.
>
> Con un segundo párrafo dentro de la misma cita.

> Cita de primer nivel
>
> > Cita anidada de segundo nivel
> >
> > > Cita anidada de tercer nivel

> **Nota:** las citas pueden contener *formato*, `código` y listas:
>
> - Elemento uno
> - Elemento dos

---

## 7. Código

Código en línea: usa `bun run server.ts ./notas` para arrancar.

### Bloque sin lenguaje

```
Texto plano sin resaltado
    con indentación conservada
y líneas  con   espacios   múltiples
```

### TypeScript

```ts
interface Archivo {
  nombre: string;
  ruta: string;
  esDirectorio: boolean;
}

async function listar(dir: string): Promise<Archivo[]> {
  const entradas = await readdir(dir, { withFileTypes: true });
  return entradas.map((e) => ({
    nombre: e.name,
    ruta: `${dir}/${e.name}`,
    esDirectorio: e.isDirectory(),
  }));
}
```

### JavaScript

```js
const servidor = Bun.serve({
  port: 3000,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("Hola");
    return new Response("No encontrado", { status: 404 });
  },
});

console.log(`Escuchando en ${servidor.url}`);
```

### Python

```python
def fibonacci(n: int) -> list[int]:
    resultado = [0, 1]
    while len(resultado) < n:
        resultado.append(resultado[-1] + resultado[-2])
    return resultado[:n]

print(fibonacci(10))  # [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
```

### Bash

```bash
#!/usr/bin/env bash
set -euo pipefail

for archivo in ./notas/*.md; do
  echo "Procesando: $archivo"
  wc -l "$archivo"
done
```

### JSON

```json
{
  "nombre": "visor-markdown",
  "version": "0.1.0",
  "atajos": {
    "editar": "e",
    "buscar": "<leader>f"
  },
  "activo": true,
  "puerto": 3000,
  "extras": null
}
```

### HTML y CSS

```html
<div class="tarjeta">
  <h2 id="titulo">Hola</h2>
  <p>Un <strong>párrafo</strong> de ejemplo.</p>
</div>
```

```css
.tarjeta {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  border-radius: 8px;
  background: var(--fondo, #fff);
}
```

### Diff

```diff
- const puerto = 8080;
+ const puerto = 3000;
  const host = "127.0.0.1";
```

### Markdown dentro de markdown

````markdown
# Título de ejemplo

Esto es un bloque de código que contiene otro bloque:

```js
console.log("anidado");
```
````

### Línea muy larga dentro de un bloque

```
Esta línea de código es extremadamente larga para comprobar que el bloque tiene scroll horizontal en lugar de romper el diseño de la página: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Bloque con sangría de cuatro espacios:

    esto es código por indentación
    sin vallas de acento grave

---

## 8. Separadores

Tres formas de escribir una línea horizontal:

---

***

___

---

## 9. Notas al pie

Aquí hay una frase con una nota al pie.[^1] Y otra con una nota distinta.[^nota-larga]

[^1]: Esta es la primera nota al pie.
[^nota-larga]: Esta nota es más larga y puede contener varios párrafos.

    Segundo párrafo de la nota, con sangría.

---

## 10. HTML embebido

<details>
<summary>Pulsa para desplegar</summary>

Contenido oculto con **markdown** dentro, una lista:

- Uno
- Dos

</details>

<p align="center"><em>Párrafo centrado con HTML.</em></p>

<div style="border: 1px solid #888; padding: 8px;">
Un <code>div</code> con estilo en línea.
</div>

Lista de definición:

<dl>
  <dt>Bun</dt>
  <dd>Runtime de JavaScript rápido.</dd>
  <dt>Markdown</dt>
  <dd>Lenguaje de marcado ligero.</dd>
</dl>

---

## 11. Prueba de sanitización (XSS)

Todo lo siguiente **no debe ejecutarse** al renderizar. Si aparece una alerta o algo se activa, falta sanitizar.

<script>alert("XSS desde script")</script>

<img src="x" onerror="alert('XSS desde onerror')">

<a href="javascript:alert('XSS desde enlace')">Enlace con javascript:</a>

<iframe src="https://example.com"></iframe>

<div onclick="alert('XSS desde onclick')">Div con onclick</div>

[Enlace markdown con javascript](javascript:alert('XSS'))

---

## 12. Casos límite

Texto con muchos asteriscos: 2 * 3 * 4 = 24 y snake_case_en_medio_de_palabra no debería ser cursiva.

Números de lista que no empiezan por 1:

5. Cinco
6. Seis
7. Siete

Lista con elementos vacíos y texto pegado:

-
- Elemento tras uno vacío

Línea con espacios al final y tabulaciones:	aquí hay un tab.

Un título sin espacio tras la almohadilla:

#NoEsTitulo

Palabra_con_guiones_bajos y **negrita con `código` dentro** y *cursiva con [enlace](https://example.com) dentro*.

---

## 13. Lista de comprobación final

- [ ] Todos los niveles de encabezado se distinguen
- [ ] Negrita, cursiva, tachado y código en línea se ven bien
- [ ] Las listas anidadas tienen la sangría correcta
- [ ] Los checkboxes se muestran como casillas
- [ ] Las tablas respetan la alineación y se pueden desplazar
- [ ] Los bloques de código tienen colores y scroll horizontal
- [ ] Las imágenes se ven y las rotas muestran el texto alternativo
- [ ] Los enlaces relativos y los de sección funcionan
- [ ] Ningún bloque de la sección 11 ejecuta código
- [ ] El editor colorea encabezados, énfasis, enlaces y código al pulsar `e`
- [ ] `Esc` guarda y vuelve a la vista renderizada
