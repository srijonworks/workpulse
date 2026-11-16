import { scriptServerTimeoutMs } from '../utils/net/scriptTimeouts';

// The server's side of /api/sheets/proxy: one call to the user's Google Apps Script, with a time limit, and every
// failure turned into a status, a code the app understands, and a plain sentence. The caller has already checked that
// the URL is a script.google.com one.

export interface ProxyRequest {
  scriptUrl: string;
  action?: string;
  method?: string;
  payload?: Record<string, unknown>;
}

export interface ProxyAnswer {
  status: number;
  body: unknown;
}

export const NOT_JSON_MESSAGE =
  'Google returned a web page instead of the script response. Deploy the script as a Web app with "Who has access" set to "Anyone", and check the URL ends in /exec.';
export const UNREACHABLE_MESSAGE = 'WorkPulse could not reach Google from this computer. Check the internet connection, then try again.';
export const TIMEOUT_MESSAGE = 'Google did not answer in time. WorkPulse will try again later.';

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** Walks an error's cause chain (undici puts the real reason in `cause`) looking for a network error code. */
export function networkCodeOf(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

const isTimeout = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
};

export async function forwardToScript(req: ProxyRequest, opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}): Promise<ProxyAnswer> {
  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? scriptServerTimeoutMs(req.action);
  try {
    const target = new URL(req.scriptUrl);
    if (req.action) target.searchParams.set('action', req.action);
    const method = req.method || (req.action === 'ping' ? 'GET' : 'POST');

    const response =
      method === 'GET'
        ? await doFetch(target.toString(), { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
        : await doFetch(target.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: req.action || req.payload?.action || 'appendLog', ...req.payload }),
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
          });

    // The script answers JSON, sometimes without the JSON content type. Anything else is a Google sign-in or error
    // page: a failure, never a success.
    const text = await response.text();
    try {
      return { status: 200, body: JSON.parse(text) };
    } catch {
      return { status: 502, body: { status: 'error', code: 'not_deployed', error: NOT_JSON_MESSAGE } };
    }
  } catch (err) {
    if (isTimeout(err)) return { status: 504, body: { status: 'error', code: 'timeout', error: TIMEOUT_MESSAGE } };
    if (networkCodeOf(err) || (err instanceof TypeError && /fetch failed/i.test(err.message))) {
      return { status: 502, body: { status: 'error', code: 'unreachable', error: UNREACHABLE_MESSAGE } };
    }
    console.error('Sheets proxy error:', err instanceof Error ? err.message : err);
    return { status: 500, body: { status: 'error', code: 'proxy_error', error: 'WorkPulse could not talk to the Google script just now.' } };
  }
}
