// How long to wait before the next try of something that keeps failing. The last delay repeats, and a little
// random spread (±20 %) keeps retries from several places from landing on the same second.

/** Delay in ms before try number `attempt` (1 is the first retry). `random` returns a number in [0, 1). */
export function nextDelay(attempt: number, delaysMs: readonly number[], random: () => number = Math.random): number {
  if (delaysMs.length === 0) return 0;
  const base = delaysMs[Math.min(Math.max(Math.floor(attempt) - 1, 0), delaysMs.length - 1)];
  return Math.round(base * (0.8 + 0.4 * random()));
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Retry schedules for the background jobs (the last value repeats). */
export const BACKOFF = {
  /** Sync of logs to the Sheet, and the day-close steps that call it. */
  sync: [30 * SECOND, 1 * MINUTE, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE],
  /** The phone page push and pull, after the first two failures. */
  phone: [1 * MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE],
  /** The copy of all data to the Sheet. */
  sheetBackup: [5 * MINUTE, 10 * MINUTE, 30 * MINUTE],
  /** The copy of all data to the disk of this computer. */
  diskCopy: [5 * SECOND, 10 * SECOND, 30 * SECOND, 1 * MINUTE, 5 * MINUTE],
} as const;
