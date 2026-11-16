// One way for the app to call its own local server: it never throws, never waits longer than `timeoutMs`, and every
// failure comes back as a kind plus a plain sentence. (Every URL the app calls is on its own server, so a request that
// fails to start means that server is not answering; problems further away, such as Google, come back as a JSON answer
// with an error from the server.)

export type NetFailKind = 'timeout' | 'server-down' | 'aborted' | 'bad-response' | 'http';

export type NetResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; kind: NetFailKind; status?: number; message: string; data?: unknown; retryable: boolean };

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  /** Sent as JSON when given. */
  body?: unknown;
  /** The request is given up after this long, even if the browser never answers or ignores the abort. */
  timeoutMs: number;
  /** The caller can cancel too (a dialog was closed). */
  signal?: AbortSignal;
  /** keepalive lets a small request finish while the page is closing. */
  keepalive?: boolean;
  fetchFn?: typeof fetch;
}

export const NET_MESSAGES = {
  timeout: 'The request took too long and was stopped.',
  serverDown: 'WorkPulse could not reach its server. Check that it is still running, then try again.',
  aborted: 'The request was cancelled.',
  badResponse: 'The server answered with something WorkPulse could not read.',
  http: 'The server could not do that.',
} as const;

const fail = (kind: NetFailKind, message: string, retryable: boolean, extra: { status?: number; data?: unknown } = {}): NetResult<never> => ({
  ok: false,
  kind,
  message,
  retryable,
  ...extra,
});

const retryableStatus = (status: number): boolean => status === 408 || status === 429 || (status >= 500 && status !== 501);

export async function requestJson<T = unknown>(url: string, o: RequestOptions): Promise<NetResult<T>> {
  const doFetch = o.fetchFn ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = () => controller.abort();
  if (o.signal) {
    if (o.signal.aborted) return fail('aborted', NET_MESSAGES.aborted, false);
    o.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const deadline = new Promise<NetResult<never>>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve(fail('timeout', NET_MESSAGES.timeout, true));
    }, o.timeoutMs);
  });

  const attempt = (async (): Promise<NetResult<T>> => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: o.method ?? 'GET',
        ...(o.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o.body) } : {}),
        ...(o.keepalive ? { keepalive: true } : {}),
        signal: controller.signal,
      });
    } catch {
      if (timedOut) return fail('timeout', NET_MESSAGES.timeout, true);
      if (o.signal?.aborted) return fail('aborted', NET_MESSAGES.aborted, false);
      return fail('server-down', NET_MESSAGES.serverDown, true);
    }

    let data: unknown;
    let parsed = true;
    try {
      data = await res.json();
    } catch {
      parsed = false;
    }
    if (!parsed) return fail('bad-response', NET_MESSAGES.badResponse, res.status >= 500, { status: res.status });
    if (res.ok) return { ok: true, status: res.status, data: data as T };

    const said = data && typeof data === 'object' ? (data as { error?: unknown; message?: unknown }) : {};
    const text = typeof said.error === 'string' && said.error ? said.error : typeof said.message === 'string' && said.message ? said.message : NET_MESSAGES.http;
    return fail('http', text, retryableStatus(res.status), { status: res.status, data });
  })();

  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onCallerAbort);
  }
}
