process.env.TZ = 'Asia/Dhaka';

import { describe, it, expect } from 'vitest';
import { recordDeletion, thresholdBoost, loadLearnHistory, saveLearnHistory, AUTOLEARN_KEY, MAX_DELETIONS } from './learn';

const now = new Date(2026, 10, 17, 12, 0);
const store = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[AUTOLEARN_KEY, initial]]);
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const auto = (projectId: string, durationMinutes: number) => ({
  origin: 'auto' as const,
  projectId,
  durationMinutes,
  sourceIds: ['a', 'b'],
});

describe('recordDeletion', () => {
  it('records auto logs only', () => {
    expect(recordDeletion([], { projectId: 'p', durationMinutes: 5 }, now)).toEqual([]);
    expect(recordDeletion([], auto('p', 10), now)).toEqual([{ projectId: 'p', minutes: 10, items: 2, date: '2026-11-17' }]);
  });
  it('caps the list', () => {
    let h = recordDeletion([], auto('p', 1), now);
    for (let i = 0; i < MAX_DELETIONS + 5; i++) h = recordDeletion(h, auto('p', 1), now);
    expect(h).toHaveLength(MAX_DELETIONS);
  });
  it('survives a junk history', () => {
    expect(recordDeletion(null as never, auto('p', 1), now)).toHaveLength(1);
  });
});

describe('thresholdBoost', () => {
  const rec = (date: string, minutes = 10, projectId = 'p') => ({ projectId, minutes, items: 1, date });
  it('is 1 with no history', () => expect(thresholdBoost([], 'p', now)).toBe(1));
  it('rises with each recent small deletion', () => {
    expect(thresholdBoost([rec('2026-11-17')], 'p', now)).toBe(1.25);
    expect(thresholdBoost([rec('2026-11-17'), rec('2026-11-17')], 'p', now)).toBe(1.5);
  });
  it('caps at 2', () => {
    expect(thresholdBoost(Array.from({ length: 20 }, () => rec('2026-11-17')), 'p', now)).toBe(2);
  });
  it('decays and ends at 14 days', () => {
    const half = thresholdBoost([rec('2026-11-10')], 'p', now);
    expect(half).toBeGreaterThan(1);
    expect(half).toBeLessThan(1.25);
    expect(thresholdBoost([rec('2026-11-03')], 'p', now)).toBe(1);
    expect(thresholdBoost([rec('2026-11-04')], 'p', now)).toBeGreaterThan(1);
  });
  it('ignores other projects, big logs, junk and future dates', () => {
    expect(thresholdBoost([rec('2026-11-17', 10, 'q')], 'p', now)).toBe(1);
    expect(thresholdBoost([rec('2026-11-17', 30)], 'p', now)).toBe(1);
    expect(thresholdBoost([rec('nope'), rec('2026-12-30')], 'p', now)).toBe(1);
    expect(thresholdBoost([null as never], 'p', now)).toBe(1);
  });
});

describe('storage', () => {
  it('round-trips', () => {
    const s = store();
    saveLearnHistory(s, [{ projectId: 'p', minutes: 3, items: 1, date: '2026-11-17' }]);
    expect(loadLearnHistory(s)).toHaveLength(1);
  });
  it('never throws on junk', () => {
    expect(loadLearnHistory(store())).toEqual([]);
    expect(loadLearnHistory(store('{not json'))).toEqual([]);
    expect(loadLearnHistory(store('{"a":1}'))).toEqual([]);
    expect(loadLearnHistory(store('[1,null,{"projectId":"p"}]'))).toEqual([]);
    const bad = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
    };
    expect(loadLearnHistory(bad)).toEqual([]);
    expect(() => saveLearnHistory(bad, [])).not.toThrow();
  });
});
