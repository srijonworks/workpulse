// A heartbeat: the page writes "I was alive at this time" every 30 seconds. After a shutdown or a crash, the last
// beat says when the PC was last in use, so a day can be closed at that time instead of at a guess. Device-only: it is
// not part of any backup. Pure: the storage is passed in.

export const HEARTBEAT_KEY = 'workpulse_heartbeat';
export const HEARTBEAT_EVERY_MS = 30_000;
/** A gap this long between two beats (or ticks) means the page was not running. */
export const GAP_MS = 120_000;

interface KVLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function writeHeartbeat(kv: KVLike, nowMs: number): boolean {
  try {
    kv.setItem(HEARTBEAT_KEY, String(Math.floor(nowMs)));
    return true;
  } catch {
    return false; // advisory data: a full or blocked store must not stop the app
  }
}

/** The last beat in ms, or null when there is none or it is not a sane time. */
export function readHeartbeat(kv: KVLike, nowMs: number): number | null {
  try {
    const raw = kv.getItem(HEARTBEAT_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n <= nowMs + 60_000 ? n : null;
  } catch {
    return null;
  }
}

export type GapDecision =
  | { kind: 'none' }
  /** The computer slept or was off: quiet, nothing to ask. */
  | { kind: 'sleep'; minutes: number }
  /** The page was not running and nothing explains it (a crash, a frozen window): tell the user, offer to add the time back. */
  | { kind: 'unexplained'; minutes: number };

/**
 * What a gap between the last beat and now means. `explainedBySleep` is true when the shell saw a suspend or lock in
 * that time (the desktop app reports it); without a shell, a gap is only called "sleep" when it is explained.
 */
export function gapDecision(o: { lastBeatMs: number | null; nowMs: number; explainedBySleep: boolean }): GapDecision {
  if (o.lastBeatMs === null) return { kind: 'none' };
  const gap = o.nowMs - o.lastBeatMs;
  if (gap < GAP_MS) return { kind: 'none' };
  const minutes = Math.round(gap / 60_000);
  return o.explainedBySleep ? { kind: 'sleep', minutes } : { kind: 'unexplained', minutes };
}
