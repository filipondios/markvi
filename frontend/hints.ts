// Etiquetas del modo de pistas de enlaces (estilo Vimium). Con pocos enlaces
// basta una letra; a partir de 27 se usan dos para que ninguna etiqueta sea
// prefijo de otra y no haya ambigüedad al teclear.

const ALPHABET = "asdfghjklqwertyuiopzxcvbnm";

export function hintLabels(count: number): string[] {
  if (count <= 0) return [];
  if (count <= ALPHABET.length) return Array.from(ALPHABET.slice(0, count));

  const labels: string[] = [];
  for (const first of ALPHABET) {
    for (const second of ALPHABET) {
      labels.push(first + second);
      if (labels.length === count) return labels;
    }
  }
  return labels;
}
