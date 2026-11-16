// Pure decisions for the desktop shell (electron/main.cjs). Nothing here imports Electron, so every rule is
// unit-tested. scripts/build-desktop.mjs bundles src/shell/index.ts into electron/app/shell.cjs, which main.cjs loads.

/**
 * True only when `url` is an address on exactly this app's origin. A look-alike such as
 * `http://localhost:38417@evil.example/` or `http://localhost:38417.evil.example/` is not.
 */
export function isOurUrl(url: unknown, origin: string): boolean {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

const CRASH_DELAYS_MS = [1_000, 5_000, 15_000];
const CRASH_WINDOW_MS = 5 * 60_000;

/**
 * What to do when the app's window (its page) has crashed. `crashTimes` holds the earlier crashes (ms); the caller
 * adds this one. Reload after a growing wait, and give up (tell the user) when it keeps crashing: four in five minutes.
 */
export function crashDecision(crashTimes: readonly number[], now: number): { action: 'reload'; delayMs: number } | { action: 'give-up' } {
  const recent = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).length + 1; // this crash counts
  if (recent >= 4) return { action: 'give-up' };
  return { action: 'reload', delayMs: CRASH_DELAYS_MS[recent - 1] };
}

/** Started by Windows at login: the window stays hidden (the tray icon is there). */
export const HIDDEN_ARG = '--hidden';
export const isHiddenStart = (argv: readonly string[]): boolean => argv.includes(HIDDEN_ARG);

/** Links WorkPulse may hand to the user's own browser or mail program. Nothing else (no file:, ms-msdt:, javascript:). */
export function isSafeExternal(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}
