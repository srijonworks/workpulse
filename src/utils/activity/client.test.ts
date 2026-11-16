import { describe, it, expect, vi, afterEach } from 'vitest';
import { scanActivityApi, suggestTasksApi } from './client';

const req = { date: '2026-11-09', folders: [], sources: { claude: false, git: true } };
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

afterEach(() => vi.unstubAllGlobals());

describe('scanActivityApi', () => {
  it('turns a network failure into a plain sentence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await scanActivityApi(req).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/failed to fetch/i);
    expect(err.message.length).toBeGreaterThan(10);
  });
  it('surfaces the server message on a non-OK answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(403, { error: 'Only works on this computer.' })));
    await expect(scanActivityApi(req)).rejects.toThrow('Only works on this computer.');
  });
  it('gives up on a scan that never answers, with a plain sentence, instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
      const run = scanActivityApi(req).catch((e) => e);
      await vi.advanceTimersByTimeAsync(76_000);
      const err = await run;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/too long/);
    } finally {
      vi.useRealTimers();
    }
  });
  it('says plainly when the server answered with something that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    const err = await scanActivityApi(req).catch((e) => e);
    expect(err.message).not.toMatch(/token|JSON/i);
  });
  it('returns the parsed body on success and posts the request as JSON', async () => {
    const body = { items: [], status: { claude: { ok: true, count: 0 }, git: { ok: true, count: 0 } } };
    const f = vi.fn().mockResolvedValue(reply(200, body));
    vi.stubGlobal('fetch', f);
    await expect(scanActivityApi(req)).resolves.toEqual(body);
    expect(f.mock.calls[0][0]).toBe('/api/activity/scan');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual(req);
  });
});

describe('suggestTasksApi', () => {
  it('returns null tasks and the notice when the server falls back', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { tasks: null, notice: 'No key' })));
    await expect(suggestTasksApi({ items: [], projectNameByFolder: {}, customApiKey: '', provider: 'claude' as const })).resolves.toEqual({ tasks: null, notice: 'No key' });
  });
  it('turns a network failure into a plain sentence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await suggestTasksApi({ items: [], projectNameByFolder: {}, customApiKey: '', provider: 'claude' as const }).catch((e) => e);
    expect(err.message).not.toMatch(/failed to fetch/i);
  });
});
