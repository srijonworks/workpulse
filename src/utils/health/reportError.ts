import { safeDetail } from './redact';

// Where an error that nobody caught ends up: the health registry (so Settings can say something happened) and the log
// file. The same error repeating in a render loop is reported once, and a session reports at most `max` of them.

export interface ErrorReport {
  area: string;
  /** A fixed sentence, never text the user typed. */
  message: string;
  /** The error's own text, redacted and short. */
  detail: string;
}

const firstStackLine = (err: unknown): string => {
  const stack = err instanceof Error ? err.stack : undefined;
  return (stack?.split('\n').slice(1).find((l) => l.trim().length > 0) ?? '').trim().slice(0, 160);
};

export function createErrorReporter(opts: { report: (r: ErrorReport) => void; max?: number }): (area: string, error: unknown) => void {
  const seen = new Set<string>();
  const max = opts.max ?? 20;
  return (area, error) => {
    if (seen.size >= max) return;
    const detail = safeDetail(error);
    const key = `${area}|${detail}|${firstStackLine(error)}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      opts.report({ area, message: `A part of WorkPulse (${area}) ran into a problem.`, detail });
    } catch {
      // reporting must never throw
    }
  };
}

/** True when a boundary's reset keys changed (the user opened another tab), so it should try its children again. */
export function resetKeysChanged(prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  const a = prev ?? [];
  const b = next ?? [];
  return a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
}

// Browsers raise this one when a layout settles over two frames. It is harmless and happens all the time.
const BENIGN = /ResizeObserver loop/i;

/** Listens for errors nothing else caught (a script error, a rejected promise) and hands them to `report`. */
export function installGlobalErrorHandlers(
  target: Pick<Window, 'addEventListener'>,
  report: (area: string, error: unknown) => void,
): void {
  target.addEventListener('error', (e) => {
    const { error, message } = e as ErrorEvent;
    if (BENIGN.test(String(message ?? error?.message ?? ''))) return;
    report('window', error ?? message);
  });
  target.addEventListener('unhandledrejection', (e) => report('promise', (e as PromiseRejectionEvent).reason));
}

/**
 * Whether the page may reload itself after a crash: once, and not again within `minGapMs`, so a bug that crashes on
 * every start ends on the "WorkPulse ran into a problem" screen instead of reloading forever.
 */
export function crashReloadDecision(i: { now: number; lastReloadAt: number | null; minGapMs?: number }): boolean {
  if (i.lastReloadAt === null) return true;
  return i.now - i.lastReloadAt >= (i.minGapMs ?? 5 * 60_000);
}
