import { describe, expect, it } from 'vitest';
import type { WorkLog } from '../../types';
import { decideAutoClockOut, endOfDayCap } from './autoClockOut';
import { busyWindows, isBusyAt } from './busy';
import { AUTO_CONFIRM_MS, decideStartPrompt, shouldAutoConfirm } from './startPrompt';

process.env.TZ = 'Asia/Dhaka';

const at = (s: string) => new Date(`${s}+06:00`).getTime();
const log = (o: Partial<WorkLog>): WorkLog =>
  ({ id: 'l', date: '2026-11-16', time: '10:00', projectId: 'p', projectName: 'P', description: 'd', status: 'Completed', tags: [], createdAt: '2026-11-16T04:00:00Z', ...o }) as WorkLog;

describe('busy time', () => {
  it('uses logs with a start time and a duration, for that date only', () => {
    const w = busyWindows([log({ time: '10:00', durationMinutes: 120 }), log({ id: 'b', durationMinutes: undefined }), log({ id: 'c', date: '2026-11-15', durationMinutes: 60 })], '2026-11-16');
    expect(w).toEqual([{ startMs: at('2026-11-16T10:00:00'), endMs: at('2026-11-16T12:00:00') }]);
    expect(isBusyAt(w, at('2026-11-16T11:59:00'))).toBe(true);
    expect(isBusyAt(w, at('2026-11-16T12:00:00'))).toBe(false);
  });
});

describe('decideAutoClockOut', () => {
  const base = { today: '2026-11-16', hours: 8, busy: [], lastAliveMs: null as number | null };
  const open = { '2026-11-16': { clockIn: '2026-11-16T03:00:00Z' } }; // 09:00 Dhaka

  it('closes a forgotten earlier day at the last time the PC was alive, never past 23:59', () => {
    const wd = { '2026-11-15': { clockIn: '2026-11-15T03:00:00Z' } };
    expect(decideAutoClockOut({ ...base, workdays: wd, nowMs: at('2026-11-16T09:00:00'), lastActivityMs: null, lastAliveMs: at('2026-11-15T18:30:00') })).toEqual({ action: 'clock-out', date: '2026-11-15', atMs: at('2026-11-15T18:30:00') });
    const late = decideAutoClockOut({ ...base, workdays: wd, nowMs: at('2026-11-16T09:00:00'), lastActivityMs: null, lastAliveMs: at('2026-11-16T01:00:00') });
    expect(late).toEqual({ action: 'clock-out', date: '2026-11-15', atMs: endOfDayCap('2026-11-15') });
  });

  it('closes an earlier day at its clock-in when nothing says more', () => {
    const wd = { '2026-11-15': { clockIn: '2026-11-15T03:00:00Z' } };
    expect(decideAutoClockOut({ ...base, workdays: wd, nowMs: at('2026-11-16T09:00:00'), lastActivityMs: null, lastAliveMs: null })).toMatchObject({ date: '2026-11-15', atMs: Date.parse('2026-11-15T03:00:00Z') });
  });

  it('closes today only when the target is done and the PC was idle for an hour, at the last activity', () => {
    const last = at('2026-11-16T17:10:00');
    expect(decideAutoClockOut({ ...base, workdays: open, nowMs: at('2026-11-16T18:20:00'), lastActivityMs: last, wholePc: true })).toEqual({ action: 'clock-out', date: '2026-11-16', atMs: last });
    expect(decideAutoClockOut({ ...base, workdays: open, nowMs: at('2026-11-16T17:50:00'), lastActivityMs: last })).toEqual({ action: 'none' }); // idle 40 min
    expect(decideAutoClockOut({ ...base, workdays: open, nowMs: at('2026-11-16T15:00:00'), lastActivityMs: at('2026-11-16T13:00:00') })).toEqual({ action: 'none' }); // target not done
  });

  it('without the PC-wide idle time (a browser), never stamps more than an hour back: a quiet window is not proof of leaving', () => {
    // Window last touched at 09:05, the app in the tray all day: the old rule closed the day at 09:05.
    const out = decideAutoClockOut({ ...base, workdays: open, nowMs: at('2026-11-16T17:30:00'), lastActivityMs: at('2026-11-16T09:05:00') });
    expect(out).toEqual({ action: 'clock-out', date: '2026-11-16', atMs: at('2026-11-16T16:30:00') });
    // With the PC-wide idle time, input anywhere keeps the day open, and the stamp is the real last input.
    expect(decideAutoClockOut({ ...base, workdays: open, nowMs: at('2026-11-16T17:30:00'), lastActivityMs: at('2026-11-16T17:29:00'), wholePc: true })).toEqual({ action: 'none' });
    expect(decideAutoClockOut({ ...base, workdays: open, nowMs: at('2026-11-16T19:15:00'), lastActivityMs: at('2026-11-16T18:10:00'), wholePc: true })).toEqual({ action: 'clock-out', date: '2026-11-16', atMs: at('2026-11-16T18:10:00') });
  });

  it('closes a day still open at midnight at its last activity in this run, not at its clock-in', () => {
    const wd = { '2026-11-15': { clockIn: '2026-11-15T03:00:00Z' } };
    // The app ran through the night; the previous run's heartbeat is from the day before.
    const o = { ...base, workdays: wd, nowMs: at('2026-11-16T00:01:00'), lastActivityMs: at('2026-11-16T00:00:30'), lastAliveMs: at('2026-11-14T18:00:00') };
    expect(decideAutoClockOut({ ...o, activityByDate: { '2026-11-15': at('2026-11-15T23:40:00'), '2026-11-16': at('2026-11-16T00:00:30') } })).toEqual({ action: 'clock-out', date: '2026-11-15', atMs: at('2026-11-15T23:40:00') });
    // This morning's activity says nothing about a day forgotten yesterday.
    expect(decideAutoClockOut({ ...o, activityByDate: { '2026-11-16': at('2026-11-16T00:00:30') } })).toMatchObject({ atMs: Date.parse('2026-11-15T03:00:00Z') });
  });

  it('never fires inside a meeting, and does nothing for a day already closed', () => {
    const busy = busyWindows([log({ time: '17:00', durationMinutes: 180 })], '2026-11-16');
    expect(decideAutoClockOut({ ...base, workdays: open, nowMs: at('2026-11-16T19:00:00'), lastActivityMs: at('2026-11-16T16:00:00'), busy })).toEqual({ action: 'none' });
    const closed = { '2026-11-16': { clockIn: '2026-11-16T03:00:00Z', clockOut: '2026-11-16T11:00:00Z' } };
    expect(decideAutoClockOut({ ...base, workdays: closed, nowMs: at('2026-11-16T20:00:00'), lastActivityMs: at('2026-11-16T10:00:00') })).toEqual({ action: 'none' });
  });
});

describe('decideStartPrompt', () => {
  const base = { workdays: {}, today: '2026-11-16', nowMs: at('2026-11-16T09:05:00'), weekday: 1, realWorkAtMs: null as number | null, dismissedDate: null as string | null };
  it('shows on a working day, suggesting now', () => {
    expect(decideStartPrompt(base)).toEqual({ action: 'show', suggestedMs: base.nowMs });
  });
  it('shows nothing when today has a record, was dismissed, or an earlier day is still open', () => {
    expect(decideStartPrompt({ ...base, workdays: { '2026-11-16': { clockIn: 'x' } } })).toEqual({ action: 'none' });
    expect(decideStartPrompt({ ...base, dismissedDate: '2026-11-16' })).toEqual({ action: 'none' });
    expect(decideStartPrompt({ ...base, workdays: { '2026-11-15': { clockIn: 'x' } } })).toEqual({ action: 'none' });
  });
  it('on Friday and Saturday shows only when real work was found, suggesting when it began', () => {
    expect(decideStartPrompt({ ...base, weekday: 5 })).toEqual({ action: 'none' });
    expect(decideStartPrompt({ ...base, weekday: 6, realWorkAtMs: at('2026-11-16T08:40:00') })).toEqual({ action: 'show', suggestedMs: at('2026-11-16T08:40:00') });
  });
});

describe('shouldAutoConfirm', () => {
  it('needs 10 minutes and someone using the PC since the popup showed', () => {
    const shown = 1_000_000;
    expect(shouldAutoConfirm({ shownAtMs: shown, nowMs: shown + AUTO_CONFIRM_MS - 1, lastActivityMs: shown + 5 })).toBe(false);
    expect(shouldAutoConfirm({ shownAtMs: shown, nowMs: shown + AUTO_CONFIRM_MS, lastActivityMs: shown + 5 })).toBe(true);
    expect(shouldAutoConfirm({ shownAtMs: shown, nowMs: shown + AUTO_CONFIRM_MS, lastActivityMs: shown - 5 })).toBe(false);
    expect(shouldAutoConfirm({ shownAtMs: shown, nowMs: shown + AUTO_CONFIRM_MS, lastActivityMs: null })).toBe(false);
  });
});
