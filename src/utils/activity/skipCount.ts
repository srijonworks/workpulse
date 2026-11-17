/** Items skipped as noise per local day, for the System status screen. Device-only. */
export interface SkipDay {
  date: string;
  count: number;
}

export const SKIPPED_KEY = 'workpulse_skipped';
export const KEEP_DAYS = 14;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the saved days (newest last); junk gives []. Never throws. */
export function loadSkipCounts(storage: StorageLike): SkipDay[] {
  try {
    const raw = storage.getItem(SKIPPED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is SkipDay =>
        !!d && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && Number.isFinite(d.count) && d.count >= 0,
    );
  } catch {
    return [];
  }
}

/** Sets a day's skipped count (a rescan replaces it, it does not add), keeps the newest 14 days, saves, returns them. */
export function recordSkipped(storage: StorageLike, date: string, count: number): SkipDay[] {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const days = loadSkipCounts(storage).filter((d) => d.date !== date);
  days.push({ date, count: safe });
  days.sort((a, b) => a.date.localeCompare(b.date));
  const kept = days.slice(-KEEP_DAYS);
  try {
    storage.setItem(SKIPPED_KEY, JSON.stringify(kept));
  } catch {
    /* ignore */
  }
  return kept;
}

/** Count skipped on one date (0 when none). */
export function skippedOn(storage: StorageLike, date: string): number {
  return loadSkipCounts(storage).find((d) => d.date === date)?.count ?? 0;
}
