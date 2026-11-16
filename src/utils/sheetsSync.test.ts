import { describe, it, expect, vi, afterEach } from 'vitest';
import { syncBatchLogsToSheet, syncSingleLogToSheet, testSheetConnection, toSheetLog } from './sheetsSync';

afterEach(() => vi.unstubAllGlobals());

describe('testSheetConnection', () => {
  const answer = (body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
  const URL_ = 'https://script.google.com/macros/s/AKfyc123/exec';

  it('version 3 is current', async () => {
    answer({ status: 'ok', version: 3, message: 'WorkPulse Google Sheets Sync is active and connected!' });
    expect(await testSheetConnection(URL_)).toEqual({ success: true, message: 'WorkPulse Google Sheets Sync is active and connected!' });
  });
  it('version 2 still syncs logs but is old for the phone features', async () => {
    answer({ status: 'ok', version: 2, message: 'active' });
    const r = await testSheetConnection(URL_);
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/Log sync works, but the phone page and evening email need the latest script/);
  });
  it('version 1 (no number) keeps the duplicate-rows message', async () => {
    answer({ status: 'ok' });
    expect((await testSheetConnection(URL_)).message).toMatch(/stop duplicate rows/);
  });
});
import type { WorkLog } from '../types';

const log = (over: Partial<WorkLog> = {}): WorkLog => ({
  id: 'log-1', date: '2026-11-09', time: '10:00', projectId: 'p', projectName: 'P',
  description: 'x', status: 'completed', tags: [], createdAt: 'c', ...over,
});

describe('toSheetLog', () => {
  it('never sends the activity source ids to the sheet', () => {
    const out = toSheetLog(log({ sourceIds: ['git:abc', 'claude:s:u'] }));
    expect(JSON.stringify(out)).not.toContain('sourceIds');
    expect(JSON.stringify(out)).not.toContain('git:abc');
  });
  it('still replaces the image with a flag', () => {
    expect(toSheetLog(log({ imageBase64: 'AAAA' })).imageBase64).toBe('true');
    expect(toSheetLog(log()).imageBase64).toBe('');
  });
});

describe('syncing logs to the Sheet', () => {
  const URL_ = 'https://script.google.com/macros/s/AKfyc123/exec';
  const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const stub = (impl: (url: string, init: RequestInit) => unknown) => {
    const f = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
    vi.stubGlobal('fetch', f);
    return f;
  };
  const sent = (f: ReturnType<typeof stub>) => JSON.parse(String(f.mock.calls[0][1].body));

  it('sends a batch through the proxy with the action twice (as before) and reports the count', async () => {
    const f = stub(() => reply({ status: 'ok', syncedCount: 2 }));
    const r = await syncBatchLogsToSheet(URL_, [log({ id: 'a' }), log({ id: 'b', sourceIds: ['git:x'] })]);
    expect(r).toEqual({ success: true, message: 'Successfully synced 2 logs to Google Sheet!', count: 2 });
    const body = sent(f);
    expect(body).toMatchObject({ scriptUrl: URL_, action: 'batchSync', method: 'POST', payload: { action: 'batchSync' } });
    expect(body.payload.logs.map((l: { id: string }) => l.id)).toEqual(['a', 'b']);
    expect(JSON.stringify(body)).not.toContain('git:x');
  });
  it('sends one log as appendLog', async () => {
    const f = stub(() => reply({ status: 'ok' }));
    expect(await syncSingleLogToSheet(URL_, log())).toEqual({ success: true, message: 'Synchronized with Google Sheet.' });
    expect(sent(f).payload).toMatchObject({ action: 'appendLog', log: { id: 'log-1' } });
  });
  it('does nothing and says so when no script is set up (single) or asks for it (batch)', async () => {
    const f = stub(() => reply({ status: 'ok' }));
    expect((await syncSingleLogToSheet('', log())).success).toBe(true);
    const batch = await syncBatchLogsToSheet(' ', [log()]);
    expect(batch.success).toBe(false);
    expect(batch.message).toMatch(/not configured/);
    expect(f).not.toHaveBeenCalled();
  });
  it('marks the busy-Sheet answer of an older script as worth retrying', async () => {
    stub(() => reply({ status: 'error', message: 'Exception: Lock timeout: another process was holding the lock for too long.' }));
    const r = await syncBatchLogsToSheet(URL_, [log()]);
    expect(r).toMatchObject({ success: false, retryable: true });
  });
  it('does not call a refusal worth retrying', async () => {
    stub(() => reply({ status: 'error', message: 'That did not work.' }));
    const r = await syncBatchLogsToSheet(URL_, [log()]);
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(false);
  });
  it('says WorkPulse itself could not be reached, plainly, and marks it retryable', async () => {
    stub(() => Promise.reject(new TypeError('Failed to fetch')));
    const r = await syncBatchLogsToSheet(URL_, [log()]);
    expect(r).toMatchObject({ success: false, retryable: true });
    expect(r.message).not.toMatch(/failed to fetch/i);
  });
  it('gives up on a sync that never answers instead of leaving the Sync button stuck', async () => {
    vi.useFakeTimers();
    stub(() => new Promise(() => {}));
    const run = syncBatchLogsToSheet(URL_, [log()]);
    await vi.advanceTimersByTimeAsync(41_000);
    const r = await run;
    vi.useRealTimers();
    expect(r).toMatchObject({ success: false, retryable: true });
    expect(r.message).toMatch(/too long/);
  });
  it('tells the connection test apart from a Google web page', async () => {
    stub(() => reply({ status: 'error', code: 'not_deployed', error: 'Google returned a web page instead of the script response.' }, 502));
    const r = await testSheetConnection(URL_);
    expect(r).toMatchObject({ success: false, message: 'Google returned a web page instead of the script response.' });
  });
});
