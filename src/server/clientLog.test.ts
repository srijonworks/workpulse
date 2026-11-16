import { describe, expect, it } from 'vitest';
import { cleanClientEntries, createLogBudget } from './clientLog';

describe('cleanClientEntries', () => {
  it('keeps the valid fields and drops everything else in the body', () => {
    const out = cleanClientEntries({
      entries: [{ level: 'warn', area: 'sheet', message: 'The Sheet is busy.', detail: 'Lock timeout', extra: 'ignored', password: 'x' }],
      other: 'ignored',
    });
    expect(out).toEqual([{ level: 'warn', area: 'sheet', message: 'The Sheet is busy.', detail: 'Lock timeout' }]);
  });
  it('treats an unknown level as an error, and leaves out an empty detail', () => {
    expect(cleanClientEntries({ entries: [{ level: 'debug', area: 'a', message: 'm', detail: '  ' }] })).toEqual([{ level: 'error', area: 'a', message: 'm' }]);
  });
  it('drops entries without an area or a message, and anything that is not an object', () => {
    expect(cleanClientEntries({ entries: [null, 5, 'x', { area: 'a' }, { message: 'm' }, { area: ' ', message: 'm' }, { area: 'a', message: 7 }] })).toEqual([]);
  });
  it('shortens long fields and takes at most 20 entries', () => {
    const [e] = cleanClientEntries({ entries: [{ area: 'a'.repeat(100), message: 'm'.repeat(1000), detail: 'd'.repeat(1000) }] });
    expect(e.area.length).toBeLessThanOrEqual(40);
    expect(e.message.length).toBeLessThanOrEqual(300);
    expect(e.detail!.length).toBeLessThanOrEqual(300);
    expect(cleanClientEntries({ entries: Array.from({ length: 50 }, () => ({ area: 'a', message: 'm' })) })).toHaveLength(20);
  });
  it('returns nothing for a body of the wrong shape', () => {
    for (const body of [null, undefined, 'x', 5, {}, { entries: 'no' }, []]) expect(cleanClientEntries(body)).toEqual([]);
  });
});

describe('createLogBudget', () => {
  it('lets 60 entries through per minute, then none, then starts again', () => {
    let t = 0;
    const b = createLogBudget({ now: () => t });
    expect(b.take(50)).toBe(50);
    expect(b.take(20)).toBe(10);
    expect(b.take(5)).toBe(0);
    t = 59_000;
    expect(b.take(5)).toBe(0);
    t = 60_000;
    expect(b.take(5)).toBe(5);
  });
});
