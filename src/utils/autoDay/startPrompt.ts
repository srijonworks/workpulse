import type { Workdays } from '../../types';

// The start-of-day popup: when to show it, which time to suggest, and when it confirms itself. Pure.

export const AUTO_CONFIRM_MS = 10 * 60_000;

export type StartDecision = { action: 'none' } | { action: 'show'; suggestedMs: number };

/**
 * Sunday to Thursday: show on the first start of the day, suggesting now. Friday and Saturday: show only when real work
 * was found (`realWorkAtMs`), suggesting when it began. Never when today has a record, an earlier day is still open
 * (it has to be closed first), or the person said "not today".
 */
export function decideStartPrompt(o: {
  workdays: Workdays;
  today: string;
  nowMs: number;
  /** 0 = Sunday ... 6 = Saturday, in the local timezone. */
  weekday: number;
  realWorkAtMs: number | null;
  dismissedDate: string | null;
}): StartDecision {
  if (o.workdays[o.today] || o.dismissedDate === o.today) return { action: 'none' };
  if (Object.keys(o.workdays).some((d) => d < o.today && !o.workdays[d].clockOut)) return { action: 'none' };
  const weekend = o.weekday === 5 || o.weekday === 6;
  if (weekend) {
    return o.realWorkAtMs === null ? { action: 'none' } : { action: 'show', suggestedMs: Math.min(o.realWorkAtMs, o.nowMs) };
  }
  return { action: 'show', suggestedMs: o.nowMs };
}

/** The popup confirms itself with the suggested time after 10 minutes, but only if someone used the PC meanwhile. */
export function shouldAutoConfirm(o: { shownAtMs: number; nowMs: number; lastActivityMs: number | null }): boolean {
  return o.nowMs - o.shownAtMs >= AUTO_CONFIRM_MS && o.lastActivityMs !== null && o.lastActivityMs >= o.shownAtMs;
}
