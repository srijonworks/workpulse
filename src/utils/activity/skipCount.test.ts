import { describe, it, expect } from 'vitest';
import { loadSkipCounts, recordSkipped, skippedOn, SKIPPED_KEY } from './skipCount';

const store = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[SKIPPED_KEY, initial]]);
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('skipCount', () => {
  it('starts empty and survives junk', () => {
    expect(loadSkipCounts(store())).toEqual([]);
    expect(loadSkipCounts(store('{bad'))).toEqual([]);
    expect(loadSkipCounts(store('"x"'))).toEqual([]);
    expect(
      loadSkipCounts(store('[{"date":"x","count":1},{"date":"2026-11-17","count":-1},{"date":"2026-11-17","count":2}]')),
    ).toEqual([{ date: '2026-11-17', count: 2 }]);
  });
  it('replaces the same day instead of adding', () => {
    const s = store();
    recordSkipped(s, '2026-11-17', 3);
    recordSkipped(s, '2026-11-17', 5);
    expect(loadSkipCounts(s)).toEqual([{ date: '2026-11-17', count: 5 }]);
    expect(skippedOn(s, '2026-11-17')).toBe(5);
    expect(skippedOn(s, '2026-11-16')).toBe(0);
  });
  it('keeps the newest 14 days in order', () => {
    const s = store();
    for (let d = 1; d <= 20; d++) recordSkipped(s, `2026-11-${String(d).padStart(2, '0')}`, d);
    const days = loadSkipCounts(s);
    expect(days).toHaveLength(14);
    expect(days[0].date).toBe('2026-11-07');
    expect(days[13].date).toBe('2026-11-20');
  });
  it('clamps bad counts and ignores a failing store', () => {
    expect(recordSkipped(store(), '2026-11-17', NaN)[0].count).toBe(0);
    expect(recordSkipped(store(), '2026-11-17', 2.7)[0].count).toBe(2);
    const bad = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
    };
    expect(() => recordSkipped(bad, '2026-11-17', 1)).not.toThrow();
  });
});
