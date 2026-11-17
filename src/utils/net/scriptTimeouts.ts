// How long the Google Apps Script is given for each action. The server stops waiting at the first value; the app,
// which waits for the server, allows a little more so the server's own answer ("Google did not answer in time") is
// what the user sees rather than a bare timeout of the app's own.

const SECOND = 1000;

/** Server-side limits per script action (the rest use `default`). */
const SERVER_MS: Record<string, number> = {
  ping: 15 * SECOND,
  sendTestEmail: 50 * SECOND,
  sendDayEmail: 50 * SECOND,
  saveHistory: 60 * SECOND,
  saveBackup: 140 * SECOND,
  loadBackup: 140 * SECOND,
};
const DEFAULT_SERVER_MS = 35 * SECOND;

/** The same Google call has a sheet or lock behind it, which is slower for these. */
export const SCRIPT_CLIENT_EXTRA_MS = 5 * SECOND;

export const scriptServerTimeoutMs = (action: string | undefined): number => SERVER_MS[action ?? ''] ?? DEFAULT_SERVER_MS;
export const scriptClientTimeoutMs = (action: string | undefined): number => scriptServerTimeoutMs(action) + SCRIPT_CLIENT_EXTRA_MS;
