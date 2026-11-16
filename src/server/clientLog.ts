import { clip } from '../utils/activity/sanitize';

// What the page may write into the log file through /api/client-log. The page is trusted no more than any input:
// only these fields, only short ones, only a few per request and per minute, and everything is redacted when it is
// written (see src/shell/fileLog.ts).

export type ClientLogLevel = 'info' | 'warn' | 'error';

export interface ClientLogEntry {
  level: ClientLogLevel;
  area: string;
  message: string;
  detail?: string;
}

const LEVELS = new Set<string>(['info', 'warn', 'error']);

/** The valid entries of a request body, trimmed to size. Anything else in the body is ignored. */
export function cleanClientEntries(body: unknown, max = 20): ClientLogEntry[] {
  const list = body && typeof body === 'object' ? (body as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(list)) return [];
  const out: ClientLogEntry[] = [];
  for (const raw of list) {
    if (out.length >= max) break;
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.area !== 'string' || typeof e.message !== 'string' || !e.area.trim() || !e.message.trim()) continue;
    out.push({
      level: typeof e.level === 'string' && LEVELS.has(e.level) ? (e.level as ClientLogLevel) : 'error',
      area: clip(e.area.trim(), 40),
      message: clip(e.message.trim(), 300),
      ...(typeof e.detail === 'string' && e.detail.trim() ? { detail: clip(e.detail.trim(), 300) } : {}),
    });
  }
  return out;
}

/** A per-minute budget. `take(n)` returns how many of n entries may be written now. */
export function createLogBudget(opts: { perMinute?: number; now?: () => number } = {}): { take(n: number): number } {
  const perMinute = opts.perMinute ?? 60;
  const now = opts.now ?? Date.now;
  let windowStart = now();
  let used = 0;
  return {
    take(n) {
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        used = 0;
      }
      const allowed = Math.max(0, Math.min(n, perMinute - used));
      used += allowed;
      return allowed;
    },
  };
}
