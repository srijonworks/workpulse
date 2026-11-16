import { describe, expect, it, vi } from 'vitest';
import { NOT_JSON_MESSAGE, TIMEOUT_MESSAGE, UNREACHABLE_MESSAGE, forwardToScript, networkCodeOf } from './scriptProxy';
import { scriptClientTimeoutMs, scriptServerTimeoutMs } from '../utils/net/scriptTimeouts';

const URL_ = 'https://script.google.com/macros/s/AKfyc123/exec';
const textReply = (text: string) => ({ text: async () => text }) as unknown as Response;
const fetchOf = (impl: (url: string, init: RequestInit) => Promise<Response>) => vi.fn(impl) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('forwardToScript: answers', () => {
  it('asks a ping with GET and the action in the address', async () => {
    const f = fetchOf(async () => textReply('{"status":"ok","version":5}'));
    const r = await forwardToScript({ scriptUrl: URL_, action: 'ping', method: 'GET' }, { fetchFn: f });
    expect(r).toEqual({ status: 200, body: { status: 'ok', version: 5 } });
    expect(f.mock.calls[0][0]).toBe(`${URL_}?action=ping`);
    expect((f.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });
  it('posts the payload with the action, and the token stays in the body, not the address', async () => {
    const f = fetchOf(async () => textReply('{"status":"ok"}'));
    await forwardToScript({ scriptUrl: URL_, action: 'pullInbox', method: 'POST', payload: { action: 'pullInbox', token: 'secret-token' } }, { fetchFn: f });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${URL_}?action=pullInbox`);
    expect(url).not.toContain('secret-token');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'pullInbox', token: 'secret-token' });
  });
  it("passes the script's own error answer through unchanged (the app reads its code)", async () => {
    const f = fetchOf(async () => textReply('{"status":"error","code":"bad_token","message":"Not linked."}'));
    expect(await forwardToScript({ scriptUrl: URL_, action: 'pushState', payload: {} }, { fetchFn: f })).toEqual({
      status: 200,
      body: { status: 'error', code: 'bad_token', message: 'Not linked.' },
    });
  });
  it('reads a JSON answer that has no JSON content type', async () => {
    const f = fetchOf(async () => textReply('  {"status":"ok"}\n'));
    expect((await forwardToScript({ scriptUrl: URL_, action: 'x' }, { fetchFn: f })).body).toEqual({ status: 'ok' });
  });
});

describe('forwardToScript: failures become a status, a code and a plain sentence', () => {
  it('treats a web page (sign-in or error page) as not deployed, never as success', async () => {
    const f = fetchOf(async () => textReply('<!doctype html><html>Sign in</html>'));
    expect(await forwardToScript({ scriptUrl: URL_, action: 'ping', method: 'GET' }, { fetchFn: f })).toEqual({
      status: 502,
      body: { status: 'error', code: 'not_deployed', error: NOT_JSON_MESSAGE },
    });
  });
  it('stops waiting for Google at the time limit (504, timeout)', async () => {
    const f = fetchOf((_url, init) => new Promise<Response>((_res, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
    const r = await forwardToScript({ scriptUrl: URL_, action: 'ping', method: 'GET' }, { fetchFn: f, timeoutMs: 40 });
    expect(r).toEqual({ status: 504, body: { status: 'error', code: 'timeout', error: TIMEOUT_MESSAGE } });
  });
  it('says Google could not be reached when the network is down (502, unreachable), without "fetch failed"', async () => {
    const down = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND script.google.com'), { code: 'ENOTFOUND' }) });
    const f = fetchOf(async () => {
      throw down;
    });
    const r = await forwardToScript({ scriptUrl: URL_, action: 'ping', method: 'GET' }, { fetchFn: f });
    expect(r).toEqual({ status: 502, body: { status: 'error', code: 'unreachable', error: UNREACHABLE_MESSAGE } });
    expect(JSON.stringify(r.body)).not.toMatch(/fetch failed|ENOTFOUND/);
  });
  it('answers anything unexpected with a plain 500 that does not leak the detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fetchOf(async () => {
      throw new Error('internal detail at C:\\secret\\path');
    });
    const r = await forwardToScript({ scriptUrl: URL_, action: 'ping', method: 'GET' }, { fetchFn: f });
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });
});

describe('networkCodeOf', () => {
  it('finds a network code on the error or anywhere down its cause chain', () => {
    expect(networkCodeOf({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(networkCodeOf({ cause: { cause: { code: 'ETIMEDOUT' } } })).toBe('ETIMEDOUT');
  });
  it('ignores other errors and odd values', () => {
    expect(networkCodeOf({ code: 'EACCES' })).toBeUndefined();
    expect(networkCodeOf(null)).toBeUndefined();
    expect(networkCodeOf('x')).toBeUndefined();
  });
});

describe('script time limits', () => {
  it('give the slow actions longer, and the app a little more than the server', () => {
    expect(scriptServerTimeoutMs('ping')).toBe(15_000);
    expect(scriptServerTimeoutMs('batchSync')).toBe(35_000);
    expect(scriptServerTimeoutMs('saveBackup')).toBe(140_000);
    expect(scriptServerTimeoutMs('sendTestEmail')).toBe(50_000);
    expect(scriptServerTimeoutMs(undefined)).toBe(35_000);
    for (const a of ['ping', 'batchSync', 'saveBackup', 'sendTestEmail']) {
      expect(scriptClientTimeoutMs(a)).toBe(scriptServerTimeoutMs(a) + 5_000);
    }
  });
});
