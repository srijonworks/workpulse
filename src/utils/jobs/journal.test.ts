import { describe, expect, it } from 'vitest';
import { JOURNAL_KEY, dueDays, readJournal, retryDelayMs, writeJournal } from './journal';

process.env.TZ = 'Asia/Dhaka';

const kv = (initial?: string) => {
  const m = new Map<string, string>(initial === undefined ? [] : [[JOURNAL_KEY, initial]]);
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const NOW = Date.parse('2026-11-16T10:00:00Z');

describe('journal storage', () => {
  it('round-trips, and keeps only the newest 60 days', () => {
    const s = kv();
    const j = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`2026-0${1 + Math.floor(i / 30)}-${String((i % 28) + 1).padStart(2, '0')}`, { state: 'done' as const, at: 'x', added: i }]));
    expect(writeJournal(s, j)).toBe(true);
    expect(Object.keys(readJournal(s)).length).toBeLessThanOrEqual(60);
  });
  it('treats a damaged or odd journal as empty or drops the bad entries', () => {
    expect(readJournal(kv('{nope'))).toEqual({});
    expect(readJournal(kv('[]'))).toEqual({});
    expect(readJournal(kv(JSON.stringify({ '2026-11-15': { state: 'done', at: 't', added: 2 }, bad: { state: 'x' }, '2026-11-14': { state: 'huh', added: 1 } })))).toEqual({
      '2026-11-15': { state: 'done', at: 't', added: 2 },
    });
  });
  it('survives storage that throws', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readJournal(bad)).toEqual({});
    expect(writeJournal(bad, {})).toBe(false);
  });
});

describe('dueDays', () => {
  const wd = {
    '2026-11-16': { clockIn: '2026-11-16T03:00:00Z', clockOut: '2026-11-16T09:59:00Z' }, // 1 minute ago
    '2026-11-15': { clockIn: '2026-11-15T03:00:00Z', clockOut: '2026-11-15T11:00:00Z' },
    '2026-11-14': { clockIn: '2026-11-14T03:00:00Z', clockOut: '2026-11-14T11:00:00Z' },
    '2026-11-13': { clockIn: '2026-11-13T03:00:00Z' }, // still open
    '2026-11-01': { clockIn: '2026-11-01T03:00:00Z', clockOut: '2026-11-01T11:00:00Z' }, // too old
  };
  it('lists closed days not yet in the journal, oldest first, after a two-minute wait, within a week', () => {
    expect(dueDays({ workdays: wd, journal: {}, nowMs: NOW })).toEqual(['2026-11-14', '2026-11-15']);
    expect(dueDays({ workdays: wd, journal: {}, nowMs: NOW + 2 * 60_000 })).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
  });
  it('skips days already in the journal', () => {
    expect(dueDays({ workdays: wd, journal: { '2026-11-14': { state: 'empty', at: '', added: 0 } }, nowMs: NOW })).toEqual(['2026-11-15']);
  });
});

describe('retryDelayMs', () => {
  it('grows 1, 5, 15, 60 minutes and then stays', () => {
    expect([1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000, 3_600_000]);
  });
});
