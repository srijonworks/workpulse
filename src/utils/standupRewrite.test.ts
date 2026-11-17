import { describe, expect, it } from 'vitest';
import type { StandupRecord } from '../types';
import { applyRewrite, needsRewrite } from './standupRewrite';

const base: StandupRecord = {
  id: 'day:2026-11-17',
  kind: 'day',
  from: '2026-11-17',
  to: '2026-11-17',
  text: 'plain',
  writer: 'template',
  notice: 'AI off',
  createdAt: '2026-11-17T10:00:00.000Z',
};

describe('needsRewrite', () => {
  it('template and unedited', () => expect(needsRewrite(base)).toBe(true));
  it('edited template', () => expect(needsRewrite({ ...base, editedAt: 'x' })).toBe(false));
  it('ai written', () => expect(needsRewrite({ ...base, writer: 'claude' })).toBe(false));
});

describe('applyRewrite', () => {
  it('rewrites, keeps createdAt, clears notice', () => {
    const other = { ...base, id: 'day:2026-11-16' };
    const out = applyRewrite([base, other], base.id, 'nice', 'claude');
    expect(out[0]).toEqual({ ...base, text: 'nice', writer: 'claude', notice: undefined });
    expect('notice' in out[0]).toBe(false);
    expect(out[0].createdAt).toBe(base.createdAt);
    expect(out[1]).toBe(other);
  });
  it('never touches an edited standup', () => {
    const edited = { ...base, editedAt: 'x' };
    const list = [edited];
    expect(applyRewrite(list, base.id, 'nice', 'gemini')[0]).toBe(edited);
  });
  it('unknown id changes nothing', () => {
    expect(applyRewrite([base], 'nope', 't', 'claude')).toEqual([base]);
  });
});
