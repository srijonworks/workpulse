import { requestJson } from '../net/http';
import type { ErrorReport } from './reportError';

// Sends what went wrong in the page to the server, which writes it to the log file (the page cannot write files).
// Entries are batched every few seconds. If the server cannot be reached they wait, up to a limit, and go with the
// next batch; the oldest are dropped first. It never throws and never makes a problem of its own.

export interface ClientLogEntry {
  level: 'info' | 'warn' | 'error';
  area: string;
  message: string;
  detail?: string;
}

export interface ClientLogSender {
  push(entry: ClientLogEntry): void;
  /** Sends what is waiting now. */
  flush(): Promise<void>;
  waiting(): number;
}

export function createClientLogSender(opts: {
  post: (entries: ClientLogEntry[]) => Promise<boolean>;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  everyMs?: number;
  maxWaiting?: number;
}): ClientLogSender {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const everyMs = opts.everyMs ?? 5000;
  const maxWaiting = opts.maxWaiting ?? 200;
  let buffer: ClientLogEntry[] = [];
  let handle: unknown = null;
  let sending = false;

  const flush = async (): Promise<void> => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
    if (sending || buffer.length === 0) return;
    sending = true;
    const batch = buffer.slice(0, 20);
    try {
      const ok = await opts.post(batch);
      if (ok) buffer = buffer.slice(batch.length);
    } catch {
      // kept for the next batch
    } finally {
      sending = false;
    }
    // More waiting (it was a big backlog, or it failed): try again later, not in a tight loop.
    if (buffer.length > 0 && handle === null) handle = schedule(() => void flush(), everyMs);
  };

  return {
    push(entry) {
      buffer.push(entry);
      if (buffer.length > maxWaiting) buffer = buffer.slice(buffer.length - maxWaiting);
      if (handle === null && !sending) handle = schedule(() => void flush(), everyMs);
    },
    flush,
    waiting: () => buffer.length,
  };
}

/** The sender the app uses: batches to /api/client-log. */
export const clientLog = createClientLogSender({
  post: async (entries) => (await requestJson('/api/client-log', { method: 'POST', body: { entries }, timeoutMs: 5000 })).ok,
});

/** Connects an error report to the sender. */
export const errorToLog = (r: ErrorReport): void => clientLog.push({ level: 'error', area: r.area, message: r.message, detail: r.detail });
