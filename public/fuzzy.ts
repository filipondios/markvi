// Búsqueda difusa por subsecuencia, al estilo de Telescope/fzf: las letras de
// cada término deben aparecer en orden, no necesariamente seguidas. Si la
// consulta tiene varias palabras, todas deben coincidir (AND). La puntuación
// premia las coincidencias contiguas y las que empiezan palabra.

export interface FuzzyMatch {
  score: number;
  /** Índices de `target` que coinciden con la consulta. */
  positions: number[];
}

export interface FuzzyResult extends FuzzyMatch {
  path: string;
}

const MATCH = 1;
const CONSECUTIVE = 8;
const GAP = -1;
const START_BONUS = 12;
const BOUNDARY_BONUS = 8;
const CAMEL_BONUS = 6;
const GAP_PENALTY = 0.05;
const LENGTH_PENALTY = 0.01;

const isSeparator = (char: string) =>
  char === "/" || char === "\\" || char === "_" || char === "-" || char === "." || char === " ";

function positionBonus(target: string, index: number) {
  if (index === 0) return START_BONUS;
  const before = target[index - 1]!;
  if (isSeparator(before)) return BOUNDARY_BONUS;
  const char = target[index]!;
  // camelCase: la mayúscula que sigue a una minúscula también empieza palabra.
  if (char !== char.toLowerCase() && before === before.toLowerCase()) return CAMEL_BONUS;
  return 0;
}

/** Devuelve la mejor coincidencia o `null` si `query` no es subsecuencia de `target`. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (query.length > target.length) return null;

  // Smart case: si la consulta lleva mayúsculas, se respeta.
  const sensitive = query !== query.toLowerCase();
  const q = sensitive ? query : query.toLowerCase();
  const t = sensitive ? target : target.toLowerCase();
  const m = q.length;
  const n = t.length;
  const NEG = Number.NEGATIVE_INFINITY;

  // Filtro rápido: descarta lo que ni siquiera es una subsecuencia.
  let cursor = 0;
  for (let qi = 0; qi < m; qi++) {
    while (cursor < n && t[cursor] !== q[qi]) cursor++;
    if (cursor >= n) return null;
    cursor++;
  }

  // dp[qi][ti]: mejor puntuación usando q[0..qi] y terminando en t[ti].
  const dp: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(NEG));
  const prev: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(-1));

  for (let ti = 0; ti < n; ti++) {
    if (t[ti] !== q[0]) continue;
    dp[0]![ti] = MATCH + positionBonus(target, ti);
  }

  // `best[k]` es el máximo de la fila anterior hasta `k`; permite resolver el
  // mejor predecesor no contiguo en tiempo constante.
  const best = new Array<number>(n).fill(NEG);
  const bestAt = new Array<number>(n).fill(-1);

  for (let qi = 1; qi < m; qi++) {
    let run = NEG;
    let runAt = -1;
    for (let ti = 0; ti < n; ti++) {
      const value = dp[qi - 1]![ti]!;
      if (value > run) {
        run = value;
        runAt = ti;
      }
      best[ti] = run;
      bestAt[ti] = runAt;
    }

    for (let ti = qi; ti < n; ti++) {
      if (t[ti] !== q[qi]) continue;

      let score = NEG;
      let from = -1;

      if (ti > 0) {
        const consecutive = dp[qi - 1]![ti - 1]!;
        if (consecutive > NEG) {
          score = consecutive + CONSECUTIVE;
          from = ti - 1;
        }
        const jump = best[ti - 1]! + GAP;
        if (jump > score) {
          score = jump;
          from = bestAt[ti - 1]!;
        }
      }

      if (from < 0) continue;
      dp[qi]![ti] = score + MATCH + positionBonus(target, ti);
      prev[qi]![ti] = from;
    }
  }

  let end = -1;
  let score = NEG;
  for (let ti = 0; ti < n; ti++) {
    const value = dp[m - 1]![ti]!;
    if (value > score) {
      score = value;
      end = ti;
    }
  }
  if (end < 0) return null;

  const positions = new Array<number>(m);
  let ti = end;
  for (let qi = m - 1; qi >= 0; qi--) {
    positions[qi] = ti;
    ti = prev[qi]![ti]!;
  }

  return {
    score: score - GAP_PENALTY * (n - m) - LENGTH_PENALTY * n,
    positions,
  };
}

export interface FuzzyItemResult<T> extends FuzzyMatch {
  item: T;
}

/** Igual que `fuzzySearch`, pero sobre elementos arbitrarios y su texto. */
export function fuzzySearchItems<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
): FuzzyItemResult<T>[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }

  const results: FuzzyItemResult<T>[] = [];
  for (const item of items) {
    const target = text(item);
    let score = 0;
    const positions = new Set<number>();
    let matches = true;

    for (const term of terms) {
      const match = fuzzyMatch(term, target);
      if (!match) {
        matches = false;
        break;
      }
      score += match.score;
      for (const position of match.positions) positions.add(position);
    }

    if (!matches) continue;
    results.push({
      item,
      score,
      positions: [...positions].sort((a, b) => a - b),
    });
  }

  return results.sort(
    (a, b) => b.score - a.score || text(a.item).localeCompare(text(b.item)),
  );
}

/** Filtra y ordena `paths` por relevancia. Sin consulta conserva el orden recibido. */
export function fuzzySearch(query: string, paths: readonly string[]): FuzzyResult[] {
  return fuzzySearchItems(query, paths, (path) => path).map((result) => ({
    path: result.item,
    score: result.score,
    positions: result.positions,
  }));
}
