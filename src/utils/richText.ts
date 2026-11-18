// A small, safe text formatter for the words WorkPulse shows but did not type: standups and AI summaries. They arrive in the
// style of chat apps and light markdown: *bold* or **bold**, _italic_, `code`, [text](https://link), "- " or "• " bullets and
// "# " headings. It returns plain data (no HTML), and the component builds React elements from it, so nothing can inject markup.
// The stored and copied text is never changed: the marks still work when it is pasted into WhatsApp or Slack.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'blank' }
  | { kind: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: 'bullet'; marker: string; inline: Inline[] }
  | { kind: 'line'; inline: Inline[] };

// One alternative per mark. Groups: 1 code, 2 **bold**, 3 *bold*, 4 label, 5 url, 6 _italic_.
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\p{L}\p{N}_])_([^_\s][^_\n]*?)_(?![\p{L}\p{N}_])/gu;

/** Splits one line into plain and marked pieces. A lone star or underscore stays as it is. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(line); m; m = INLINE.exec(line)) {
    if (m.index > last) out.push({ kind: 'text', text: line.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'bold', text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: 'bold', text: m[3] });
    else if (m[4] !== undefined && m[5] !== undefined) out.push({ kind: 'link', text: m[4], href: m[5] });
    else out.push({ kind: 'italic', text: m[6] });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) });
  return out;
}

const HEADING = /^(#{1,3})\s+(.+)$/;
const BULLET = /^\s*([-•]|\d{1,2}[.)])\s+(.+)$/;

/** Splits text into lines, blank gaps, headings and bullets. Every line break the writer made is kept. */
export function parseBlocks(text: string): Block[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map((line): Block => {
    if (line.trim() === '') return { kind: 'blank' };
    const h = HEADING.exec(line);
    if (h) return { kind: 'heading', level: h[1].length as 1 | 2 | 3, inline: parseInline(h[2]) };
    const b = BULLET.exec(line);
    if (b) return { kind: 'bullet', marker: b[1] === '-' ? '•' : b[1], inline: parseInline(b[2]) };
    return { kind: 'line', inline: parseInline(line) };
  });
}
