// Smart case compartido: la misma consulta debe comportarse igual en el
// documento, el buscador de archivos y la búsqueda del servidor.

export function isCaseSensitive(query: string): boolean {
  return query !== query.toLowerCase();
}
