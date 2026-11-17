/** Learning from deleted automatic logs: a project whose small auto logs keep being deleted needs a higher bar. */
export interface DeletionRecord {
  projectId: string;
  minutes: number;
  items: number;
  /** YYYY-MM-DD (local). */
  date: string;
}

export type LearnHistory = DeletionRecord[];

export const AUTOLEARN_KEY = 'workpulse_autolearn';
export const MAX_DELETIONS = 50;
export const DECAY_DAYS = 14;
const SMALL_LOG_MINUTES = 30;
const STEP = 0.25;
const DAY_MS = 86400000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const dayNumber = (date: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS : NaN;
};

const localDate = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** Adds a deletion when the log is an auto log; any other log returns the history unchanged. Capped to the newest 50. */
export function recordDeletion(
  history: LearnHistory,
  log: { origin?: string; projectId: string; durationMinutes?: number; underlyingTasks?: unknown[]; sourceIds?: string[] },
  now: Date = new Date(),
): LearnHistory {
  const base = Array.isArray(history) ? history : [];
  if (log.origin !== 'auto' || !log.projectId) return base;
  const record: DeletionRecord = {
    projectId: log.projectId,
    minutes: Math.max(0, log.durationMinutes ?? 0),
    items: log.sourceIds?.length ?? log.underlyingTasks?.length ?? 0,
    date: localDate(now),
  };
  return [...base, record].slice(-MAX_DELETIONS);
}

/**
 * Multiplier 1.0 to 2.0 for the project's log threshold: each deletion of a small auto log (under 30 min)
 * in the last 14 days adds 0.25, fading linearly to nothing at 14 days.
 */
export function thresholdBoost(history: LearnHistory, projectId: string, now: Date = new Date()): number {
  const today = dayNumber(localDate(now));
  let boost = 1;
  for (const d of Array.isArray(history) ? history : []) {
    if (!d || d.projectId !== projectId || !(d.minutes < SMALL_LOG_MINUTES)) continue;
    const age = today - dayNumber(d.date);
    if (!(age >= 0) || age >= DECAY_DAYS) continue;
    boost += STEP * (1 - age / DECAY_DAYS);
  }
  return Math.min(2, Math.round(boost * 1000) / 1000);
}

/** Reads the saved history; junk or missing data gives []. Never throws. */
export function loadLearnHistory(storage: StorageLike): LearnHistory {
  try {
    const raw = storage.getItem(AUTOLEARN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (d): d is DeletionRecord =>
          !!d &&
          typeof d.projectId === 'string' &&
          typeof d.minutes === 'number' &&
          typeof d.items === 'number' &&
          typeof d.date === 'string' &&
          !Number.isNaN(dayNumber(d.date)),
      )
      .slice(-MAX_DELETIONS);
  } catch {
    return [];
  }
}

/** Saves the history; a failing store is ignored. */
export function saveLearnHistory(storage: StorageLike, history: LearnHistory): void {
  try {
    storage.setItem(AUTOLEARN_KEY, JSON.stringify(history.slice(-MAX_DELETIONS)));
  } catch {
    /* quota or private mode: learning is optional */
  }
}
