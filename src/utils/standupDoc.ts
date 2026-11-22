// The one structure every standup is read into, so the app (History) and the emails show it the same way. The email script
// has its own copy of these rules (standupDoc_ in src/utils/appsScript/email.ts, plain ES5); standupDoc.test.ts runs the
// same samples through both and fails if they ever read a standup differently.
//
// The text format every writer produces:
//
//   *What I completed today:*          a heading: a line that is only bold (or "# Heading")
//   - *hims:* Made HMIS stateless      a point, tagged with its project
//     - Shared rate limits             a sub-point: indented (2+ spaces) under the point above
//   - *idim:* Fixed Comm Store issues
//
// Points with the same project in a section are gathered under that project, in the order each project first appears.
// The stored text is never changed; marks (*bold*, _italic_) are drawn when it is shown.

export type SectionKind = 'done' | 'doing' | 'blocked' | 'other';

export interface StandupPoint {
  text: string;
  subs: string[];
}

export type StandupItem =
  | { kind: 'project'; label: string; points: StandupPoint[] }
  | { kind: 'point'; point: StandupPoint }
  | { kind: 'line'; text: string };

export interface StandupSection {
  title: string;
  kind: SectionKind;
  items: StandupItem[];
}

const HEADING = /^#{1,3}\s+(.+)$/;
// A line that is only bold, maybe after an emoji or symbol, is a heading; the symbol is dropped.
const BOLD_LINE = /^\*{1,2}([^*\n]+?)\*{1,2}\s*$/;
const LEADING_SYMBOLS = /^[^A-Za-z0-9*#ঀ-৿]+/;
const BULLET = /^(\s*)([-•]|\d{1,2}[.)])\s+(.+)$/;
const TAG = /^\*{1,2}([^*\n]+?):\*{1,2}\s*(.*)$/;

/** What a heading announces: work done, work going on, or something stuck. */
export function sectionKind(title: string): SectionKind {
  if (/block|waiting|stuck|risk/i.test(title)) return 'blocked';
  if (/progress|rolling|next|plan|tomorrow|ongoing/i.test(title)) return 'doing';
  if (/complet|done|finish|shipped/i.test(title)) return 'done';
  return 'other';
}

const indentOf = (ws: string) => ws.replace(/\t/g, '  ').length;

export function parseStandup(text: string): StandupSection[] {
  const sections: StandupSection[] = [];
  let cur: StandupSection | null = null;
  let last: StandupPoint | null = null;
  const section = (): StandupSection => {
    if (!cur) {
      cur = { title: '', kind: 'other', items: [] };
      sections.push(cur);
    }
    return cur;
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') continue;
    const bullet = BULLET.exec(line);
    const h = HEADING.exec(line.trim());
    const bold = BOLD_LINE.exec(line.replace(LEADING_SYMBOLS, '').trim());
    if (h || (bold && !bullet)) {
      const title = (h ? h[1] : bold![1]).trim();
      cur = { title, kind: sectionKind(title), items: [] };
      sections.push(cur);
      last = null;
      continue;
    }
    const sec = section();
    if (bullet) {
      const content = bullet[3].trim();
      if (indentOf(bullet[1]) >= 2 && last) {
        last.subs.push(content);
        continue;
      }
      const tag = TAG.exec(content);
      const label = tag ? tag[1].trim() : '';
      if (tag && label) {
        const point: StandupPoint = { text: tag[2].trim(), subs: [] };
        const group = sec.items.find((it): it is Extract<StandupItem, { kind: 'project' }> => it.kind === 'project' && it.label.toLowerCase() === label.toLowerCase());
        if (group) group.points.push(point);
        else sec.items.push({ kind: 'project', label, points: [point] });
        last = point;
      } else {
        const point: StandupPoint = { text: content, subs: [] };
        sec.items.push({ kind: 'point', point });
        last = point;
      }
      continue;
    }
    sec.items.push({ kind: 'line', text: line.trim() });
    last = null;
  }
  return sections;
}

/** True for a point that only says there is nothing ("None"), shown quieter. */
export const isNothing = (text: string): boolean => /^\s*(none|nothing|n\/a|-)\.?\s*$/i.test(text.replace(/\*/g, ''));
