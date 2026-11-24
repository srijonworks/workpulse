import type { Workdays } from '../../types';
import { localDateOfIso } from '../dates';
import { clockState } from '../workday';
import { isBusyAt, type BusyWindow } from './busy';

// When the day closes by itself. A person who forgets to clock out should not have an open day for ever, and a person
// in a meeting should not be clocked out in the middle of it. Pure: the caller passes what it knows and acts on the
// answer. Clock-out is still manual in normal use; this is the safety net.

export const IDLE_BEFORE_CLOCK_OUT_MS = 60 * 60_000;

/** Never later than 23:59 of the day itself. */
export function endOfDayCap(date: string): number {
  return new Date(`${date}T23:59:00`).getTime();
}

export type ClockOutDecision = { action: 'none' } | { action: 'clock-out'; date: string; atMs: number };

export function decideAutoClockOut(o: {
  workdays: Workdays;
  today: string;
  nowMs: number;
  /** The last time anything on this PC was in use (input anywhere when the desktop shell knows it, else this window's input; activity found). Null when unknown. */
  lastActivityMs: number | null;
  /** True when lastActivityMs covers input anywhere on the PC (the desktop shell). In a browser only this window's input is
   *  known, and a quiet window does not prove the person left: the clock-out is then never stamped more than an hour back. */
  wholePc?: boolean;
  /** The last activity seen in this run, per local date (the day before midnight, for a day still open after it). */
  activityByDate?: Record<string, number>;
  /** The last heartbeat of the previous run: when the app was last alive before it started now. */
  lastAliveMs: number | null;
  hours: number;
  busy: BusyWindow[];
}): ClockOutDecision {
  // An earlier day that was never closed: stamp it at the last time the PC was alive (the previous run's heartbeat) or in use
  // on that date in this run (the app ran past midnight), never past 23:59 of that day.
  const stale = Object.keys(o.workdays).filter((d) => d < o.today && !o.workdays[d].clockOut).sort();
  for (const date of stale) {
    const inMs = Date.parse(o.workdays[date].clockIn);
    const prevRun = o.lastAliveMs !== null && localDateOfIso(new Date(o.lastAliveMs).toISOString()) >= date ? o.lastAliveMs : null;
    const thisRun = o.activityByDate?.[date] ?? null;
    const alive = prevRun === null ? thisRun : thisRun === null ? prevRun : Math.max(prevRun, thisRun);
    const atMs = Math.min(Math.max(alive ?? inMs, inMs), endOfDayCap(date));
    return { action: 'clock-out', date, atMs };
  }

  // Today: the target is done, the PC has been idle for an hour, and no meeting is on.
  const rec = o.workdays[o.today];
  if (!rec || rec.clockOut || o.lastActivityMs === null) return { action: 'none' };
  const inMs = Date.parse(rec.clockIn);
  if (clockState(rec, o.hours, o.nowMs).leftSec > 0) return { action: 'none' };
  if (o.nowMs - o.lastActivityMs < IDLE_BEFORE_CLOCK_OUT_MS) return { action: 'none' };
  if (isBusyAt(o.busy, o.nowMs)) return { action: 'none' };
  const floor = o.wholePc ? inMs : Math.max(inMs, o.nowMs - IDLE_BEFORE_CLOCK_OUT_MS);
  const atMs = Math.min(Math.max(o.lastActivityMs, floor), endOfDayCap(o.today));
  return { action: 'clock-out', date: o.today, atMs };
}
