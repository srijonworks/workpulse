import { clip, redactSecrets } from '../activity/sanitize';

// Everything that goes into a log file or a "Copy diagnostics" text passes through here first. On top of the key and
// token patterns the activity code already removes, it hides what only this app knows is private: the script address
// (anyone with it can call the script), PINs and tokens in a request body, e-mail addresses and the Windows user name.

const SCRIPT_URL = /(https:\/\/script\.google\.com\/macros\/s\/)([A-Za-z0-9_-]{8,})(\/[A-Za-z]+)?/g;
const SECRET_FIELD = /("(?:pin|oldPin|newPin|token|phoneToken|customApiKey|geminiApiKey)"\s*:\s*)"[^"]*"/gi;
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const WINDOWS_PROFILE = /([A-Za-z]:\\Users\\)[^\\/\s"']+/gi;

export function redactForLog(text: string): string {
  return redactSecrets(text)
    .replace(SCRIPT_URL, (_m, head: string, id: string, tail: string | undefined) => `${head}${id.slice(0, 4)}…${id.slice(-4)}${tail ?? ''}`)
    .replace(SECRET_FIELD, '$1"***"')
    .replace(EMAIL, (_m, first: string, domain: string) => `${first}***@${domain}`)
    .replace(WINDOWS_PROFILE, '$1<user>');
}

/** What a log line may hold of an error's detail: redacted, one line, and short. */
export function safeDetail(detail: unknown, max = 300): string {
  const text = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : detail === undefined || detail === null ? '' : String(detail);
  return clip(redactForLog(text).replace(/\s+/g, ' ').trim(), max);
}
