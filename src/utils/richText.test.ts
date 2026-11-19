import { describe, expect, it } from 'vitest';
import { groupByProject, parseBlocks, parseInline } from './richText';

describe('parseInline', () => {
  it('reads chat-style and markdown bold, italic, code and links', () => {
    expect(parseInline('*a* and **b**').map((p) => p.kind)).toEqual(['bold', 'text', 'bold']);
    expect(parseInline('see `npm test` now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' now' },
    ]);
    expect(parseInline('_late_ start')[0]).toEqual({ kind: 'italic', text: 'late' });
    expect(parseInline('[docs](https://example.com/a)')).toEqual([{ kind: 'link', text: 'docs', href: 'https://example.com/a' }]);
  });

  it('leaves lone marks, snake_case and non-http links alone', () => {
    expect(parseInline('5 * 3 = 15')).toEqual([{ kind: 'text', text: '5 * 3 = 15' }]);
    expect(parseInline('use my_var_name here')).toEqual([{ kind: 'text', text: 'use my_var_name here' }]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ kind: 'text', text: '[x](javascript:alert(1))' }]);
    expect(parseInline('')).toEqual([]);
  });

  it('keeps a project tag bold with its colon, as the standup writes it', () => {
    expect(parseInline('*hims:* Code fixes')).toEqual([
      { kind: 'bold', text: 'hims:' },
      { kind: 'text', text: ' Code fixes' },
    ]);
  });
});

describe('parseBlocks', () => {
  it('keeps every line break and blank gap', () => {
    const b = parseBlocks('*What I completed today:*\n• *hims:* fixes\n\nNone');
    expect(b.map((x) => x.kind)).toEqual(['heading', 'bullet', 'blank', 'line']);
  });

  it('makes a bold line after an emoji a heading and drops the emoji', () => {
    const [h] = parseBlocks('\u{1F680} *What I completed today:*');
    expect(h).toEqual({ kind: 'heading', level: 2, inline: [{ kind: 'bold', text: 'What I completed today:' }] });
  });

  it('reads bullets, numbers and headings, and a star before a word is not a bullet', () => {
    expect(parseBlocks('- one')[0]).toMatchObject({ kind: 'bullet', marker: '•' });
    expect(parseBlocks('2) two')[0]).toMatchObject({ kind: 'bullet', marker: '2)' });
    expect(parseBlocks('## Title')[0]).toMatchObject({ kind: 'heading', level: 2 });
    expect(parseBlocks('*Blockers*')[0].kind).toBe('heading');
    expect(parseBlocks('*Blockers* none')[0].kind).toBe('line');
    expect(parseBlocks('* spaced')[0].kind).toBe('line');
  });

  it('groups project-tagged bullets per section, in first-seen order, ignoring case', () => {
    const b = groupByProject(parseBlocks('*Done:*\n• *wp:* a\n• *hims:* b\n\n• *WP:* c\nNote\n*Next:*\n• *hims:* d\n• plain'));
    expect(b.map((x) => x.kind)).toEqual(['heading', 'group', 'group', 'line', 'heading', 'group', 'bullet']);
    expect(b[1]).toEqual({ kind: 'group', label: 'wp', items: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'c' }]] });
    expect(b[2]).toMatchObject({ label: 'hims', items: [[{ kind: 'text', text: 'b' }]] });
  });

  it('leaves text without project tags as it was', () => {
    const blocks = parseBlocks('*Done:*\n• one\n\nNone');
    expect(groupByProject(blocks)).toEqual(blocks);
  });

  it('handles Windows line endings', () => {
    expect(parseBlocks('a\r\nb').length).toBe(2);
  });
});
