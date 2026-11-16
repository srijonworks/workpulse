import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateAiReport, standupRequestBody } from './aiGenerator';
import { eodRequestBody } from './eodSynthesis';

const logs: any[] = [
  { id: 'l1', status: 'completed', projectName: 'Alpha', description: 'Fixed login', tags: [], durationMinutes: 30 },
];
const base = { logs, format: 'slack' as const, tone: 'casual' as const, customApiKey: 'AIza-secret' };
const reply = (ok: boolean, body: unknown, status = ok ? 200 : 502) =>
  vi.fn().mockResolvedValue({ ok, status, json: async () => body }) as any;

describe('request bodies', () => {
  it('carry the provider and no key unless Gemini is the writer', () => {
    expect(standupRequestBody('claude', 'p', 's', 'AIza-secret')).toMatchObject({ provider: 'claude', customApiKey: undefined });
    expect(standupRequestBody('gemini', 'p', 's', 'AIza-secret')).toMatchObject({ provider: 'gemini', customApiKey: 'AIza-secret' });
    expect(eodRequestBody('claude', [], [], 'd', 'AIza-secret').customApiKey).toBeUndefined();
    expect(eodRequestBody('gemini', [], [], 'd', 'AIza-secret')).toMatchObject({ provider: 'gemini', customApiKey: 'AIza-secret' });
  });
});

describe('generateAiReport', () => {
  // plainAiMessage reads navigator.onLine, which Node does not report as true
  beforeEach(() => vi.stubGlobal('navigator', { onLine: true }));
  afterEach(() => vi.unstubAllGlobals());
  it('asks Claude by default and never sends the Gemini key', async () => {
    const fetchFn = reply(true, { text: ' Hi team ', modelUsed: 'Claude Code' });
    const r = await generateAiReport({ ...base, fetchFn });
    expect(r).toMatchObject({ text: 'Hi team', source: 'claude', model: 'Claude Code' });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.provider).toBe('claude');
    expect('customApiKey' in body).toBe(false);
  });
  it('sends the key and provider when Gemini is chosen', async () => {
    const fetchFn = reply(true, { text: 'Hi', modelUsed: 'gemini-3.5-flash' });
    const r = await generateAiReport({ ...base, ai: 'gemini', fetchFn });
    expect(r.source).toBe('gemini');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toMatchObject({ provider: 'gemini', customApiKey: 'AIza-secret' });
  });
  it('makes no server call with No AI', async () => {
    const fetchFn = vi.fn() as any;
    const r = await generateAiReport({ ...base, ai: 'none', fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.source).toBe('template');
    expect(r.error).toBeUndefined();
    expect(r.text).toContain('Fixed login');
  });
  it('falls back to the template with a plain reason when Claude did not answer', async () => {
    const notice = 'Claude Code is not installed. Showing the offline template instead.';
    const r = await generateAiReport({ ...base, fetchFn: reply(true, { text: '', notice }) });
    expect(r.source).toBe('template');
    expect(r.error).toMatch(/not installed/);
    expect(r.text).toContain('Fixed login');
  });
  it('never shows a raw network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as any;
    const r = await generateAiReport({ ...base, fetchFn });
    expect(r.source).toBe('template');
    expect(r.error).toMatch(/could not reach its server/);
    expect(r.error).not.toMatch(/Failed to fetch/);
  });
  it('gives up on a server that never answers and returns the template, so the dialog is never stuck', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(() => new Promise(() => {})) as any;
      const run = generateAiReport({ ...base, fetchFn });
      await vi.advanceTimersByTimeAsync(101_000);
      const r = await run;
      expect(r.source).toBe('template');
      expect(r.error).toMatch(/too long/);
      expect(r.text).toContain('Fixed login');
    } finally {
      vi.useRealTimers();
    }
  });
});
