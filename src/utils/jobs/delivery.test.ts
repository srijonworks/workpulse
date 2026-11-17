import { describe, expect, it } from 'vitest';
import type { StandupRecord, WorkLog } from '../../types';
import { DELIVERY_KEY, daysToDeliver, historyRow, readDelivery, writeDelivery } from './delivery';

process.env.TZ = 'Asia/Dhaka';

const NOW = Date.parse('2026-11-19T10:00:00Z'); // Thursday
const standup = (id: string): StandupRecord => ({ id, kind: id.startsWith('week') ? 'week' : 'day', from: '2026-11-15', to: '2026-11-15', text: 't', writer: 'template', createdAt: 'x' });
const wd = (d: string) => ({ clockIn: `${d}T03:00:00Z`, clockOut: `${d}T11:30:00Z` });

describe('daysToDeliver', () => {
  const workdays = { '2026-11-17': wd('2026-11-17'), '2026-11-18': wd('2026-11-18'), '2026-11-19': { clockIn: '2026-11-19T03:00:00Z' }, '2026-11-01': wd('2026-11-01') };
  const standups = [standup('day:2026-11-17'), standup('day:2026-11-19'), standup('day:2026-11-01')];

  it('lists closed days in the last week that have a standup and are not queued', () => {
    expect(daysToDeliver({ workdays, standups, delivery: {}, nowMs: NOW })).toEqual(['2026-11-17']);
  });
  it('skips queued days, open days and days without a standup', () => {
    expect(daysToDeliver({ workdays, standups, delivery: { '2026-11-17': { state: 'queued', at: 'x' } }, nowMs: NOW })).toEqual([]);
  });
  it('comes back to a Thursday once its week standup exists', () => {
    const w = { '2026-11-19': wd('2026-11-19') };
    const day = [standup('day:2026-11-19')];
    expect(daysToDeliver({ workdays: w, standups: day, delivery: { '2026-11-19': { state: 'queued', at: 'x' } }, nowMs: NOW })).toEqual([]);
    expect(daysToDeliver({ workdays: w, standups: [...day, standup('week:2026-11-19')], delivery: { '2026-11-19': { state: 'queued', at: 'x' } }, nowMs: NOW })).toEqual(['2026-11-19']);
    expect(daysToDeliver({ workdays: w, standups: [...day, standup('week:2026-11-19')], delivery: { '2026-11-19': { state: 'queued', at: 'x', week: true } }, nowMs: NOW })).toEqual([]);
  });
});

describe('historyRow', () => {
  it('sums worked, logged minutes and the count for the date', () => {
    const logs = [{ date: '2026-11-17', durationMinutes: 60 }, { date: '2026-11-17', durationMinutes: 30 }, { date: '2026-11-16', durationMinutes: 99 }] as WorkLog[];
    expect(historyRow('2026-11-17', { '2026-11-17': wd('2026-11-17') }, logs)).toMatchObject({ workedMinutes: 510, loggedMinutes: 90, logCount: 2 });
  });
});

describe('delivery storage', () => {
  it('round-trips and ignores damage', () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    writeDelivery(kv, { '2026-11-17': { state: 'queued', at: 't', week: true } });
    expect(readDelivery(kv)).toEqual({ '2026-11-17': { state: 'queued', at: 't', week: true } });
    m.set(DELIVERY_KEY, '{nope');
    expect(readDelivery(kv)).toEqual({});
  });
});
