import type { WorkLog } from '../../types';

// Busy time: a log written by hand with a start time and a duration (a meeting, field work) says the person was busy
// then, so the automatic clock-out must not fire inside it. Pure.

export interface BusyWindow {
  startMs: number;
  endMs: number;
}

/** The windows of the logs of one date that have both a start time (HH:MM) and a duration. */
export function busyWindows(logs: WorkLog[], date: string): BusyWindow[] {
  const out: BusyWindow[] = [];
  for (const l of logs) {
    if (l.date !== date || !l.durationMinutes || l.durationMinutes <= 0 || !/^\d{2}:\d{2}$/.test(l.time)) continue;
    const startMs = new Date(`${date}T${l.time}:00`).getTime();
    if (Number.isNaN(startMs)) continue;
    out.push({ startMs, endMs: startMs + l.durationMinutes * 60_000 });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export const isBusyAt = (windows: BusyWindow[], ms: number): boolean => windows.some((w) => ms >= w.startMs && ms < w.endMs);
