// Formato de respuesta de búsqueda compartido por servidor y cliente. Sin
// importaciones de Node ni del DOM: el navegador también lo consume.

export interface SearchHit {
  path: string;
  /** Línea del archivo, empezando en 1. */
  line: number;
  /** Texto de la línea, sin sangría y recortado alrededor de la coincidencia. */
  text: string;
  /** Rangos `[desde, hasta)` de las coincidencias dentro de `text`. */
  matches: [number, number][];
}

export interface SearchResults {
  results: SearchHit[];
  /** Hay más coincidencias de las que se devuelven. */
  truncated: boolean;
}
