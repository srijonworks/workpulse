// Turns what went wrong with an AI request into one plain sentence a colleague can act on.
// The server and the network layer produce technical strings ("Failed to fetch", "429 ...").

export function plainAiMessage(raw: string | undefined, online: boolean = typeof navigator === 'undefined' ? true : navigator.onLine): string {
  const text = (raw || '').trim();
  if (!online) return 'You are offline, so the AI cannot be reached.';
  if (/api[ _-]?key.*(missing|provided|not set|configure)|no gemini api key|GEMINI_API_KEY/i.test(text)) {
    return 'No Gemini key is set. Add one in Settings under AI.';
  }
  if (/API_KEY_INVALID|permission|unauthori[sz]ed|forbidden|\b(401|403)\b|key not valid/i.test(text)) {
    return 'Gemini did not accept the key. Check it in Settings under AI.';
  }
  if (/\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED|too many requests/i.test(text)) {
    return 'Gemini has reached its usage limit for now. Try again in a few minutes.';
  }
  if (/failed to fetch|networkerror|load failed|could not reach|econnrefused/i.test(text)) {
    return 'WorkPulse could not reach its server. Check that it is still running, then try again.';
  }
  if (!text) return 'The AI did not answer.';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

// What an older Apps Script (before version 6) lets through when Google or the Sheet is busy: the raw exception text.
const SHEET_BUSY = /lock timeout|another process was holding the lock/i;
const SHEET_GOOGLE_TROUBLE = /service invoked too many times|exceeded maximum execution time|service spreadsheets failed|service timed out|server error occurred|internal error/i;

/** True for a script answer that only means "not now" (a busy Sheet, a Google hiccup): the same request can work later. */
export function isTransientSheetText(raw: string | undefined): boolean {
  const text = raw || '';
  return SHEET_BUSY.test(text) || SHEET_GOOGLE_TROUBLE.test(text);
}

/** Same idea for the Google Sheet. */
export function plainSheetMessage(raw: string | undefined, online: boolean = typeof navigator === 'undefined' ? true : navigator.onLine): string {
  const text = (raw || '').trim();
  if (!online) return 'You are offline. The log is saved here and will go to the Sheet when you sync again.';
  if (SHEET_BUSY.test(text)) return 'The Sheet is busy with another request. WorkPulse will try again.';
  if (SHEET_GOOGLE_TROUBLE.test(text)) return 'Google had a problem with the Sheet just now. WorkPulse will try again.';
  if (/failed to fetch|networkerror|load failed|could not reach|econnrefused/i.test(text)) {
    return 'WorkPulse could not reach its server, so nothing was sent.';
  }
  if (/\b(401|403)\b|permission|unauthori[sz]ed|authori[sz]ation|access/i.test(text)) {
    return 'The Sheet script refused the request. Check that it is deployed for "Anyone" and the URL is the latest one.';
  }
  return text || 'The Sheet did not accept the logs.';
}
