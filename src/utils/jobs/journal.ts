import type { Workdays } from '../../types';
import { localDateStr } from '../dates';

// The day-close journal: which days have been closed out (their automatic logs added), so a day is handled once, a
// reload in the middle never repeats it, and days missed while the PC was off are caught up. Device-only. Pure: the
// storage is passed in.

export const JOURNAL_KEY = 'workpulse_journal';
export const CLOSE_GRACE_MS = 2 * 60_000;
export const CATCH_UP_DAYS = 7;
const KEEP = 60;

export interface JournalEntry {
  /** 'done': logs were added; 'empty': the day had nothing to add. */
  state: 'done' | 'empty';
  at: string;
  added: number;
}
export type Journal = Record<string, JournalEntry>;

interface KVLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readJournal(kv: KVLike): Journal {
  try {
    const raw = kv.getItem(JOURNAL_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Journal = {};
    for (const [date, e] of Object.entries(v as Record<string, Partial<JournalEntry>>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && e && (e.state === 'done' || e.state === 'empty') && typeof e.added === 'number') {
        out[date] = { state: e.state, at: typeof e.at === 'string' ? e.at : '', added: e.added };
      }
    }
    return out;
  } catch {
    return {}; // a damaged journal is treated as empty: the worst case is a day being looked at again, and logs are never added twice
  }
}

export function writeJournal(kv: KVLike, journal: Journal): boolean {
  try {
    const dates = Object.keys(journal).sort();
    const kept: Journal = {};
    for (const d of dates.slice(-KEEP)) kept[d] = journal[d];
    kv.setItem(JOURNAL_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

/**
 * The days to close out now, oldest first: clocked out at least two minutes ago (a quick Resume cancels it), not in the
 * journal, and not older than a week.
 */
export function dueDays(o: { workdays: Workdays; journal: Journal; nowMs: number; graceMs?: number }): string[] {
  const grace = o.graceMs ?? CLOSE_GRACE_MS;
  const oldest = localDateStr(new Date(o.nowMs - CATCH_UP_DAYS * 24 * 3600 * 1000));
  return Object.keys(o.workdays)
    .filter((d) => {
      const out = o.workdays[d].clockOut;
      return !!out && d >= oldest && !o.journal[d] && o.nowMs - Date.parse(out) >= grace;
    })
    .sort();
}

/** How long to wait before trying a day again after attempt number `attempt` (1 = first failure) failed. */
export function retryDelayMs(attempt: number): number {
  const steps = [1, 5, 15, 60];
  return steps[Math.min(Math.max(attempt, 1), steps.length) - 1] * 60_000;
}
