import type { ErrorRequestHandler } from 'express';

// One place that turns a server failure into a plain sentence, so no raw "PayloadTooLargeError", HTML error page or
// stack trace reaches the app, and a stray error cannot take the whole server down.

/** The status and sentence for an error a route let escape (body-parser failures, or a bug). */
export function describeRouteError(err: unknown): { status: number; error: string } {
  const e = (err ?? {}) as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (e.type === 'entity.too.large') return { status: 413, error: 'That request was too large for WorkPulse to take.' };
  if (e.type === 'entity.parse.failed') return { status: 400, error: 'WorkPulse could not read that request.' };
  const status = Number(e.status ?? e.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) return { status, error: 'WorkPulse could not use that request.' };
  return { status: 500, error: 'WorkPulse hit an unexpected problem. Please try again.' };
}

/** Express error middleware, mounted last: always an answer the app can read, as JSON. */
export const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const { status, error } = describeRouteError(err);
  if (status >= 500) console.error('WorkPulse server error:', err instanceof Error ? err.message : err);
  res.status(status).json({ error });
};

/** What to tell the user when the server cannot open its port. */
export function listenErrorMessage(err: { code?: unknown; message?: unknown }, port: number): string {
  if (err.code === 'EADDRINUSE') {
    return `Port ${port} is already in use. Close the other program using it (or another copy of WorkPulse) and start again.`;
  }
  if (err.code === 'EACCES') return `WorkPulse is not allowed to use port ${port}.`;
  return `WorkPulse could not start its server: ${String(err.message || 'unknown error')}`;
}

/**
 * For the standalone server (npm run dev / npm start): a stray rejected promise is logged instead of ending the
 * process. The desktop app has its own handlers in electron/main.cjs, so this is not installed there.
 */
export function installProcessGuards(proc: Pick<NodeJS.Process, 'on'> = process, log: (...a: unknown[]) => void = console.error): void {
  proc.on('unhandledRejection', (reason) => log('WorkPulse unhandled rejection:', reason instanceof Error ? reason.message : reason));
}
