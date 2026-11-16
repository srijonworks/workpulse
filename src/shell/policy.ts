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
