// Standups are written for chat apps, where *text* is bold. A card cannot show those stars as bold by itself, so this splits a
// line into plain and bold pieces. The stored and copied text keeps the stars (they work when pasted into WhatsApp or Slack).

export interface Piece {
  text: string;
  bold: boolean;
}

/** Splits text on `*bold*` marks. A lone star, or stars around nothing, stay as plain text. */
export function splitBold(text: string): Piece[] {
  const out: Piece[] = [];
  const re = /\*([^*\n]+)\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1].trim() === '') continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}
