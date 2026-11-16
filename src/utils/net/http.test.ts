import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestJson } from './http';

afterEach(() => vi.useRealTimers());

const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const fetchOf = (impl: (url: string, init: RequestInit) => Promise<Response> | Response) => vi.fn(async (url: string, init: RequestInit) => impl(url, init)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('requestJson: answers', () => {
  it('returns the data of a good answer', async () => {
    const f = fetchOf(() => reply({ status: 'ok', n: 1 }));
    expect(await requestJson('/api/x', { timeoutMs: 1000, fetchFn: f })).toEqual({ ok: true, status: 200, data: { status: 'ok', n: 1 } });
  });
  it('sends a JSON body with its header, and no body or header on a plain GET', async () => {
    const f = fetchOf(() => reply({}));
    await requestJson('/api/x', { method: 'POST', body: { a: 1 }, timeoutMs: 1000, fetchFn: f });
    const post = f.mock.calls[0][1] as RequestInit;
    expect(post.method).toBe('POST');
    expect(post.body).toBe('{"a":1}');
    expect(post.headers).toEqual({ 'Content-Type': 'application/json' });
    await requestJson('/api/x', { timeoutMs: 1000, fetchFn: f });
    const get = f.mock.calls[1][1] as RequestInit;
    expect(get.method).toBe('GET');
    expect(get.body).toBeUndefined();
  });
  it("uses the server's own sentence for an error answer, with its status and body", async () => {
    const f = fetchOf(() => reply({ status: 'error', code: 'unreachable', error: 'Could not reach Google.' }, 502));
    const r = await requestJson('/api/x', { timeoutMs: 1000, fetchFn: f });
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 502, message: 'Could not reach Google.', retryable: true });
    if (!r.ok) expect(r.data).toEqual({ status: 'error', code: 'unreachable', error: 'Could not reach Google.' });
  });
  it('says which statuses are worth retrying', async () => {
    const retry = async (status: number) => {
      const r = await requestJson('/api/x', { timeoutMs: 1000, fetchFn: fetchOf(() => reply({ error: 'e' }, status)) });
      return !r.ok && r.retryable;
    };
    expect(await retry(400)).toBe(false);
    expect(await retry(403)).toBe(false);
    expect(await retry(413)).toBe(false);
    expect(await retry(501)).toBe(false);
    expect(await retry(408)).toBe(true);
    expect(await retry(429)).toBe(true);
    expect(await retry(500)).toBe(true);
    expect(await retry(504)).toBe(true);
  });
  it('turns a web page (an answer that is not JSON) into a plain failure, not "Unexpected token"', async () => {
    const f = fetchOf(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } }) as unknown as Response);
    const r = await requestJson('/api/x', { timeoutMs: 1000, fetchFn: f });
    expect(r).toMatchObject({ ok: false, kind: 'bad-response', retryable: false });
    if (!r.ok) expect(r.message).not.toMatch(/token|JSON/i);
  });
});

describe('requestJson: failures that never throw', () => {
  it('says the local server is not answering when the request cannot start', async () => {
    const f = fetchOf(() => Promise.reject(new TypeError('Failed to fetch')));
    const r = await requestJson('/api/x', { timeoutMs: 1000, fetchFn: f });
    expect(r).toMatchObject({ ok: false, kind: 'server-down', retryable: true });
    if (!r.ok) expect(r.message).not.toMatch(/failed to fetch/i);
  });
  it('gives up at the deadline and aborts the request', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const f = fetchOf((_url, init) => {
      seen = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const run = requestJson('/api/x', { timeoutMs: 5000, fetchFn: f });
    await vi.advanceTimersByTimeAsync(5001);
    expect(await run).toMatchObject({ ok: false, kind: 'timeout', retryable: true });
    expect(seen?.aborted).toBe(true);
  });
  it('still gives up at the deadline when the request ignores the abort and never settles', async () => {
    vi.useFakeTimers();
    const f = fetchOf(() => new Promise<Response>(() => {}));
    const run = requestJson('/api/x', { timeoutMs: 3000, fetchFn: f });
    await vi.advanceTimersByTimeAsync(3001);
    expect(await run).toMatchObject({ ok: false, kind: 'timeout' });
  });
  it('reports a cancel by the caller as aborted, and does not start a request that was cancelled already', async () => {
    const controller = new AbortController();
    const f = fetchOf((_url, init) => new Promise<Response>((_res, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const run = requestJson('/api/x', { timeoutMs: 60_000, signal: controller.signal, fetchFn: f });
    controller.abort();
    expect(await run).toMatchObject({ ok: false, kind: 'aborted', retryable: false });
    const again = await requestJson('/api/x', { timeoutMs: 1000, signal: controller.signal, fetchFn: f });
    expect(again).toMatchObject({ ok: false, kind: 'aborted' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('leaves no timer behind after a fast answer', async () => {
    vi.useFakeTimers();
    await requestJson('/api/x', { timeoutMs: 30_000, fetchFn: fetchOf(() => reply({})) });
    expect(vi.getTimerCount()).toBe(0);
  });
});
