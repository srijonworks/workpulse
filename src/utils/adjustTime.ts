import type { BacklogTask } from '../types';
import { localDateOfIso } from './dates';
import { unloggedSeconds } from './taskLogging';

// "Adjust time": fixing a timer that was started late or left running by mistake. Both fixes keep the time honest: a
// timer started late is moved back to the real start (the extra time is added, never invented), and a finished task's
// total can be set to what really happened. Every change is recorded in `adjustedSeconds` (signed) so it can be shown.
// Pure: nothing here touches storage.

export type AdjustResult<T> = { ok: true; task: BacklogTask; info: T } | { ok: false; message: string };

/** "HH:MM" on the local date of `refIso`, as ISO. Null when it is not a time. */
export function timeOnDateOf(hhmm: string, refIso: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const d = new Date(`${localDateOfIso(refIso)}T${hhmm}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A running timer that should have started earlier. The open segment moves its start back to `newStartIso`, and the
 * difference is added to the tracked time. The new start must be earlier than the current start of the run, not before
 * the end of an earlier run of the same task (those minutes are already counted), and on the same day as the run.
 */
export function backdateRunning(task: BacklogTask, newStartIso: string): AdjustResult<{ addedSeconds: number }> {
  const segments = task.segments ?? [];
  const open = segments[segments.length - 1];
  if (!open || open.end !== undefined) return { ok: false, message: 'This timer is not running.' };
  const newMs = Date.parse(newStartIso);
  const openMs = Date.parse(open.start);
  if (Number.isNaN(newMs)) return { ok: false, message: 'Enter the time you really started, for example 09:50.' };
  if (newMs >= openMs) return { ok: false, message: 'Pick a time before the timer started. To remove time, use Pause or Edit the tracked time afterwards.' };
  if (localDateOfIso(newStartIso) !== localDateOfIso(open.start)) return { ok: false, message: 'The start has to be on the same day the timer started.' };
  const previous = segments[segments.length - 2];
  if (previous?.end && newMs < Date.parse(previous.end)) {
    return { ok: false, message: 'That is before this task was paused earlier, and that time is already counted. Pick a later time.' };
  }
  const added = Math.round((openMs - newMs) / 1000);
  const next: BacklogTask = {
    ...task,
    elapsedSeconds: (task.elapsedSeconds ?? 0) + added,
    adjustedSeconds: (task.adjustedSeconds ?? 0) + added,
    segments: [...segments.slice(0, -1), { ...open, start: newStartIso }],
    // the task's first start moves too when this is its first run
    startedAt: segments.length === 1 ? newStartIso : task.startedAt,
  };
  return { ok: true, task: next, info: { addedSeconds: added } };
}

/**
 * A task that is not running: set its tracked time to `totalSeconds`. It cannot go below the time already written into a
 * log, and it is capped at 24 hours. The strip of work blocks is not changed (it only draws what the timer measured).
 */
export function setTrackedTotal(task: BacklogTask, totalSeconds: number): AdjustResult<{ changedSeconds: number }> {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return { ok: false, message: 'Enter the time as hours and minutes.' };
  const total = Math.round(totalSeconds);
  if (total > 24 * 3600) return { ok: false, message: 'A task cannot have more than 24 hours.' };
  const logged = task.loggedSeconds ?? 0;
  if (total < logged) {
    return { ok: false, message: 'Part of this time is already written into a log. Edit that log to change it, or enter at least what is logged.' };
  }
  const before = task.elapsedSeconds ?? 0;
  if (total === before) return { ok: false, message: 'That is the time already recorded.' };
  const changed = total - before;
  return { ok: true, task: { ...task, elapsedSeconds: total, adjustedSeconds: (task.adjustedSeconds ?? 0) + changed }, info: { changedSeconds: changed } };
}

/** The most recent minutes already counted in logs for this task (so the dialog can say what the floor is). */
export const lockedSeconds = (task: BacklogTask): number => Math.max(0, (task.elapsedSeconds ?? 0) - unloggedSeconds(task));

/** "+20m" or "-5m" for the row, or null when nothing was adjusted. */
export function adjustedLabel(task: BacklogTask): string | null {
  const s = task.adjustedSeconds ?? 0;
  if (!s) return null;
  const m = Math.max(1, Math.round(Math.abs(s) / 60));
  const h = Math.floor(m / 60);
  const text = h > 0 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
  return `${s > 0 ? '+' : '-'}${text} by hand`;
}
