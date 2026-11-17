// @vitest-environment node
process.env.TZ = 'Asia/Dhaka';
import { describe, it, expect } from 'vitest';
import { standupPeriod, isWeekClose, weekWindow, standupContext, upsertStandup } from './standup';
import type { StandupRecord, WorkLog } from '../types';

const log = (n: number, date = '2026-11-12', desc = 'did thing'): WorkLog => ({
  id: `l${n}`, date, time: '10:00', projectId: 'p', projectName: 'Alpha', description: desc,
  status: 'completed', tags: [], createdAt: 'c',
});

describe('standup periods', () => {
  it('2026-11-12 is a Thursday: day and week Friday..Thursday', () => {
    expect(isWeekClose('2026-11-12')).toBe(true);
    expect(isWeekClose('2026-11-13')).toBe(false);
    expect(weekWindow('2026-11-12')).toEqual({ from: '2026-11-06', to: '2026-11-12' });
    const p = standupPeriod('2026-11-12');
    expect(p.day).toMatchObject({ id: 'day:2026-11-12', from: '2026-11-12', to: '2026-11-12' });
    expect(p.week).toMatchObject({ id: 'week:2026-11-12', from: '2026-11-06', to: '2026-11-12' });
  });
  it('a normal day has no week', () => {
    expect(standupPeriod('2026-11-11').week).toBeUndefined();
  });
  it('window crosses a month end', () => {
    expect(weekWindow('2026-12-03')).toEqual({ from: '2026-11-27', to: '2026-12-03' });
  });
});

describe('standupContext', () => {
  it('states dates and keeps only logs in range', () => {
    const c = standupContext({ logs: [log(1), log(2, '2026-11-01')], tasks: [], from: '2026-11-12', to: '2026-11-12' });
    expect(c).toContain('Period: 2026-11-12');
    expect(c).toContain('did thing');
    expect(c).not.toContain('2026-11-01');
  });
  it('caps 40 logs, 300 chars each, 12k total', () => {
    const many = Array.from({ length: 60 }, (_, i) => log(i, '2026-11-12', 'x'.repeat(1000)));
    const c = standupContext({ logs: many, tasks: [], from: '2026-11-12', to: '2026-11-12' });
    expect(c.split('\n').filter((l) => l.startsWith('2026-11-12 ['))).toHaveLength(40);
    expect(Math.max(...c.split('\n').map((l) => l.length))).toBeLessThanOrEqual(300);
    expect(c.length).toBeLessThanOrEqual(12_000);
  });
  it('redacts secrets', () => {
    const c = standupContext({ logs: [log(1, '2026-11-12', 'set password=hunter2 now')], tasks: [], from: '2026-11-12', to: '2026-11-12' });
    expect(c).not.toContain('hunter2');
  });
  it('feeds day standups into a week', () => {
    const s: StandupRecord = { id: 'day:2026-11-10', kind: 'day', from: '2026-11-10', to: '2026-11-10', text: 'Shipped the thing', writer: 'template', createdAt: 'c' };
    const c = standupContext({ logs: [], tasks: [], from: '2026-11-06', to: '2026-11-12', dayStandups: [s] });
    expect(c).toContain('Shipped the thing');
  });
});

describe('upsertStandup', () => {
  it('replaces by id or appends', () => {
    const a: StandupRecord = { id: 'day:1', kind: 'day', from: '1', to: '1', text: 'a', writer: 'template', createdAt: 'c' };
    expect(upsertStandup([a], { ...a, text: 'b' })[0].text).toBe('b');
    expect(upsertStandup([a], { ...a, id: 'day:2' })).toHaveLength(2);
  });
});
