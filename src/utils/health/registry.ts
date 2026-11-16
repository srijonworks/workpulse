// One record per subsystem (saving, the disk copy, the Sheet, e-mail ...) of when it last worked and since when it has
// been failing, with a plain sentence for the user. A failure is quiet at first, because most heal by themselves: it
// only becomes a warning once it has lasted past that subsystem's threshold. Pure, with the clock passed in.

export type Severity = 'ok' | 'warning' | 'critical';

export interface HealthEntry {
  id: string;
  /** Since when it has been failing without a success in between. */
  failingSince?: number;
  lastOkAt?: number;
  lastFailAt?: number;
  /** The same failure repeated, in a row. */
  count: number;
  /** A plain sentence for the user. */
  message?: string;
  /** Short technical text for the diagnostics (redacted before it is shown or saved). */
  detail?: string;
  /** Worth trying again later: no one has to do anything. */
  retryable?: boolean;
  /** What the user can do ("Open Settings", "Redeploy the script"). */
  action?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface Threshold {
  /** A failure counts as a warning once it has lasted this long (0: at once)... */
  warnAfterMs: number;
  /** ...and has happened at least this many times in a row. */
  minCount?: number;
  /** A critical problem (the user is told even when the window is hidden). */
  criticalAfterMs?: number;
}

/** When each subsystem's failure matters. Anything not listed waits 10 minutes. */
export const THRESHOLDS: Record<string, Threshold> = {
  storage: { warnAfterMs: 0, criticalAfterMs: 2 * MINUTE },
  diskCopy: { warnAfterMs: 30 * MINUTE },
  server: { warnAfterMs: 0, minCount: 2 },
  sheetSync: { warnAfterMs: 2 * HOUR, minCount: 3, criticalAfterMs: 24 * HOUR },
  phone: { warnAfterMs: 1 * HOUR },
  sheetBackup: { warnAfterMs: 6 * HOUR },
  dayClose: { warnAfterMs: 0, criticalAfterMs: 24 * HOUR },
  email: { warnAfterMs: 0, criticalAfterMs: 24 * HOUR },
  activity: { warnAfterMs: 0 },
  app: { warnAfterMs: 0 },
};
const DEFAULT_THRESHOLD: Threshold = { warnAfterMs: 10 * MINUTE };

export function severityOf(entry: HealthEntry, now: number): Severity {
  if (entry.failingSince === undefined) return 'ok';
  const t = THRESHOLDS[entry.id] ?? DEFAULT_THRESHOLD;
  const lasted = now - entry.failingSince;
  if (t.criticalAfterMs !== undefined && lasted >= t.criticalAfterMs) return 'critical';
  if (lasted >= t.warnAfterMs && entry.count >= (t.minCount ?? 1)) return 'warning';
  return 'ok';
}

export interface FailureReport {
  message: string;
  detail?: string;
  retryable?: boolean;
  action?: string;
}

export interface HealthRegistry {
  reportOk(id: string): void;
  reportFail(id: string, report: FailureReport): void;
  get(id: string): HealthEntry | undefined;
  /** Every subsystem that has reported, in a stable order. The same array until something changes. */
  entries(): HealthEntry[];
  /** The ones that need the user's eyes now, worst first. */
  attention(): { entry: HealthEntry; severity: Exclude<Severity, 'ok'> }[];
  subscribe(fn: () => void): () => void;
  /** For keeping the timeline across a reload. */
  serialize(): string;
  restore(json: string | null): void;
}

export function createHealthRegistry(opts: { now?: () => number } = {}): HealthRegistry {
  const now = opts.now ?? Date.now;
  const map = new Map<string, HealthEntry>();
  const listeners = new Set<() => void>();
  let list: HealthEntry[] = [];

  const changed = () => {
    list = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // a listener must not break a report
      }
    }
  };

  return {
    reportOk(id) {
      const e = map.get(id);
      // A success changes nothing visible when nothing was failing and it was already recorded recently.
      if (e && e.failingSince === undefined && e.lastOkAt !== undefined && now() - e.lastOkAt < 1000) return;
      map.set(id, { id, count: 0, lastOkAt: now() });
      changed();
    },
    reportFail(id, report) {
      const prev = map.get(id);
      const t = now();
      map.set(id, {
        id,
        failingSince: prev?.failingSince ?? t,
        lastOkAt: prev?.lastOkAt,
        lastFailAt: t,
        // The same failure again counts; a different one starts the count over but keeps the failing-since time.
        count: prev?.failingSince !== undefined && prev.message === report.message ? prev.count + 1 : 1,
        message: report.message,
        detail: report.detail,
        retryable: report.retryable,
        action: report.action,
      });
      changed();
    },
    get: (id) => map.get(id),
    entries: () => list,
    attention() {
      const t = now();
      const out: { entry: HealthEntry; severity: 'warning' | 'critical' }[] = [];
      for (const entry of map.values()) {
        const severity = severityOf(entry, t);
        if (severity !== 'ok') out.push({ entry, severity });
      }
      return out.sort((a, b) => (a.severity === b.severity ? a.entry.id.localeCompare(b.entry.id) : a.severity === 'critical' ? -1 : 1));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    serialize() {
      // Only the timeline, never the free text: nothing a person typed or a path can end up here.
      return JSON.stringify([...map.values()].map((e) => ({ id: e.id, failingSince: e.failingSince, lastOkAt: e.lastOkAt, lastFailAt: e.lastFailAt, count: e.count })));
    },
    restore(json) {
      if (!json) return;
      try {
        const rows = JSON.parse(json) as unknown;
        if (!Array.isArray(rows)) return;
        for (const r of rows) {
          if (!r || typeof r !== 'object' || typeof (r as { id?: unknown }).id !== 'string') continue;
          const o = r as Partial<HealthEntry> & { id: string };
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
          // Without its message a restored failure has nothing to show, so only the "last worked" time is brought back.
          map.set(o.id, { id: o.id, count: 0, lastOkAt: num(o.lastOkAt) });
        }
        changed();
      } catch {
        // damaged: start clean
      }
    },
  };
}

/** The app's registry. */
export const health = createHealthRegistry();
