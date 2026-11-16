// How long the app waits for its own server on the calls that can be slow. They are longer than what the server itself
// allows (Claude Code 60 s, up to four Gemini tries of 18 s, a scan under 60 s), so the server's own answer, with its
// plain reason, is what the user sees rather than a bare timeout of the app's.

/** Writing a standup, the end-of-day text, or grouping activity (Claude Code or Gemini). */
export const AI_REQUEST_TIMEOUT_MS = 100_000;

/** Reading the day's git commits and Claude Code history. */
export const ACTIVITY_SCAN_TIMEOUT_MS = 75_000;
