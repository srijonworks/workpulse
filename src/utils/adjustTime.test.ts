import { describe, expect, it } from 'vitest';
import type { BacklogTask } from '../types';
import { adjustedLabel, backdateRunning, setTrackedTotal, timeOnDateOf } from './adjustTime';

process.env.TZ = 'Asia/Dhaka';

const task = (o: Partial<BacklogTask> = {}): BacklogTask => ({
  id: 't', title: 't', projectId: 'p', dueDate: '2026-11-17', completed: false, originalDate: '2026-11-17', isRolledOver: false,
  stage: 'in_progress', isRunning: true, elapsedSeconds: 2400, startedAt: '2026-11-17T04:30:00.000Z', // 10:30 Dhaka
  segments: [{ start: '2026-11-17T04:30:00.000Z' }], ...o,
});
const at = (hhmm: string) => timeOnDateOf(hhmm, '2026-11-17T04:30:00.000Z') as string;

describe('timeOnDateOf', () => {
  it('puts HH:MM on the local date', () => {
    expect(at('09:50')).toBe('2026-11-17T03:50:00.000Z');
    expect(timeOnDateOf('25:00', '2026-11-17T04:30:00Z')).toBeNull();
    expect(timeOnDateOf('9:5', '2026-11-17T04:30:00Z')).toBeNull();
  });
});

describe('backdateRunning', () => {
  it('moves the start back and adds the difference', () => {
    const r = backdateRunning(task(), at('09:50'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.addedSeconds).toBe(40 * 60);
    expect(r.task.elapsedSeconds).toBe(2400 + 2400);
    expect(r.task.adjustedSeconds).toBe(2400);
    expect(r.task.segments).toEqual([{ start: at('09:50') }]);
    expect(r.task.startedAt).toBe(at('09:50'));
  });
  it('keeps the first start when this is a later run, and refuses to overlap the earlier run', () => {
    const t = task({ segments: [{ start: '2026-11-17T02:00:00.000Z', end: '2026-11-17T03:00:00.000Z' }, { start: '2026-11-17T04:30:00.000Z' }], startedAt: '2026-11-17T02:00:00.000Z' });
    const ok = backdateRunning(t, '2026-11-17T03:30:00.000Z');
    expect(ok.ok && ok.task.startedAt).toBe('2026-11-17T02:00:00.000Z');
    expect(backdateRunning(t, '2026-11-17T02:30:00.000Z')).toMatchObject({ ok: false });
  });
  it('refuses a later time, another day, a stopped timer and junk', () => {
    expect(backdateRunning(task(), at('11:00'))).toMatchObject({ ok: false });
    expect(backdateRunning(task(), '2026-11-16T04:00:00.000Z')).toMatchObject({ ok: false });
    expect(backdateRunning(task({ segments: [{ start: '2026-11-17T04:30:00.000Z', end: '2026-11-17T05:00:00.000Z' }] }), at('09:50'))).toMatchObject({ ok: false });
    expect(backdateRunning(task(), 'nope')).toMatchObject({ ok: false });
  });
});

describe('setTrackedTotal', () => {
  const paused = task({ stage: 'paused', isRunning: false, segments: [{ start: '2026-11-17T04:30:00.000Z', end: '2026-11-17T05:10:00.000Z' }] });
  it('sets the total and records the change, up or down', () => {
    const up = setTrackedTotal(paused, 4800);
    expect(up.ok && up.task.elapsedSeconds).toBe(4800);
    expect(up.ok && up.task.adjustedSeconds).toBe(2400);
    const down = setTrackedTotal({ ...paused, adjustedSeconds: 600 }, 1800);
    expect(down.ok && down.task.adjustedSeconds).toBe(600 - 600);
  });
  it('cannot go below what is already in a log, above 24 hours, or to the same value', () => {
    expect(setTrackedTotal({ ...paused, loggedSeconds: 2000 }, 1000)).toMatchObject({ ok: false });
    expect(setTrackedTotal(paused, 25 * 3600)).toMatchObject({ ok: false });
    expect(setTrackedTotal(paused, 2400)).toMatchObject({ ok: false });
    expect(setTrackedTotal(paused, -1)).toMatchObject({ ok: false });
  });
});

describe('adjustedLabel', () => {
  it('names the adjustment for the row', () => {
    expect(adjustedLabel(task())).toBeNull();
    expect(adjustedLabel(task({ adjustedSeconds: 1200 }))).toBe('+20m by hand');
    expect(adjustedLabel(task({ adjustedSeconds: 4500 }))).toBe('+1h 15m by hand');
    expect(adjustedLabel(task({ adjustedSeconds: -300 }))).toBe('-5m by hand');
  });
});
