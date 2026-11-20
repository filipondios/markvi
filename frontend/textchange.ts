export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Calcula el cambio contiguo mínimo entre dos textos, respetando pares UTF-16. */
export function minimalTextChange(before: string, after: string): TextChange {
  let from = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (
    from < sharedLength &&
    before.charCodeAt(from) === after.charCodeAt(from) &&
    !splitsSurrogatePair(before, from + 1) &&
    !splitsSurrogatePair(after, from + 1)
  ) {
    from++;
  }

  let oldEnd = before.length;
  let newEnd = after.length;
  while (
    oldEnd > from &&
    newEnd > from &&
    before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1) &&
    !splitsSurrogatePair(before, oldEnd - 1) &&
    !splitsSurrogatePair(after, newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}

function splitsSurrogatePair(text: string, offset: number) {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
