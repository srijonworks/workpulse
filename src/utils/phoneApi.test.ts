import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pullInbox,
  pushState,
  ackInbox,
  setPhonePin,
  setEmailSchedule,
  sendTestEmail,
  resetPhoneAccess,
  getScriptVersion,
  probeScript,
  saveBackupToSheet,
  getBackupInfo,
  loadBackupFromSheet,
  saveHistory,
  sendDayEmail,
  getEmailStatus,
  cancelDayEmail,
  dayEmailKey,
  HISTORY_SCRIPT_VERSION,
} from './phoneApi';
import type { PhoneSnapshot } from './phoneSync';

const URL_ = 'https://script.google.com/macros/s/AKfyc123/exec';

function stubFetch(impl: (url: string, init: RequestInit) => Promise<unknown> | unknown) {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const sentBody = (fn: ReturnType<typeof stubFetch>) => JSON.parse(String(fn.mock.calls[0][1].body));

afterEach(() => vi.unstubAllGlobals());

describe('phoneApi', () => {
  it('pullInbox posts the token (no pin) to the proxy and parses items', async () => {
    const items = [{ id: 'phone-1', title: 'T', projectId: 'p', projectName: 'P', dueDate: '2026-11-12', createdAt: 'x' }];
    const f = stubFetch(() => reply({ status: 'ok', items }));
    const r = await pullInbox(URL_, 'tok123');
    expect(r.ok).toBe(true);
    expect(r.data?.items).toEqual(items);
    expect(f.mock.calls[0][0]).toBe('/api/sheets/proxy');
    expect(sentBody(f)).toEqual({
      scriptUrl: URL_,
      action: 'pullInbox',
      method: 'POST',
      payload: { action: 'pullInbox', token: 'tok123' },
    });
    expect(JSON.stringify(sentBody(f))).not.toContain('"pin"');
  });

  it('turns a network failure into a plain sentence', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const r = await pullInbox(URL_, 't');
    expect(r.ok).toBe(false);
    expect(r.message).not.toMatch(/failed to fetch/i);
    expect(r.message.length).toBeGreaterThan(10);
  });

  it('surfaces the script error code and its own message', async () => {
    stubFetch(() => reply({ status: 'error', code: 'locked', message: 'Phone access is locked for 15 minutes.' }));
    const r = await pullInbox(URL_, 't');
    expect(r).toEqual({ ok: false, code: 'locked', message: 'Phone access is locked for 15 minutes.' });
  });

  it('falls back to a plain sentence for a coded error with no message', async () => {
    stubFetch(() => reply({ status: 'error', code: 'bad_token' }));
    const r = await pullInbox(URL_, 't');
    expect(r.code).toBe('bad_token');
    expect(r.message).toMatch(/not linked/);
    expect(r.message).toContain('Use Reset phone access in Settings (it asks for your current PIN).');
    expect(r.message).not.toMatch(/Set the PIN again/);
  });

  it('treats a proxy error body and a non-JSON answer as failures', async () => {
    stubFetch(() => reply({ error: 'Only Google Apps Script URLs are allowed' }, 400));
    expect((await ackInbox(URL_, 't', ['a'])).ok).toBe(false);
    stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    const r = await ackInbox(URL_, 't', ['a']);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad_response');
  });

  it('refuses an empty script URL without calling fetch', async () => {
    const f = stubFetch(() => reply({ status: 'ok' }));
    const r = await sendTestEmail('  ', 't');
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('keeps the PIN out of every URL and sends it only in the body', async () => {
    const f = stubFetch(() => reply({ status: 'ok', token: 'newtoken' }));
    const r = await setPhonePin(URL_, '4821', { oldPin: '1111' });
    expect(r.data?.token).toBe('newtoken');
    await resetPhoneAccess(URL_, '4821', '9999');
    for (const call of f.mock.calls) {
      expect(String(call[0])).not.toContain('?');
      expect(String(call[0])).not.toContain('4821');
    }
    expect(JSON.parse(String(f.mock.calls[0][1].body)).payload).toEqual({ action: 'setPin', pin: '4821', oldPin: '1111' });
    expect(JSON.parse(String(f.mock.calls[1][1].body)).payload).toEqual({ action: 'resetAccess', pin: '4821', newPin: '9999' });
  });

  it('sends the other actions with the expected payloads', async () => {
    const f = stubFetch(() => reply({ status: 'ok' }));
    await setEmailSchedule(URL_, 'tok', { enabled: true, hour: 18, minute: 0, tz: 'Asia/Dhaka' });
    await sendTestEmail(URL_, 'tok');
    await ackInbox(URL_, 'tok', ['a', 'b']);
    const snap = { tasks: [], logs: [], workdays: {}, projects: [], workdayHours: 8, tz: 'Asia/Dhaka', deviceId: 'd', today: '2026-11-11' } as PhoneSnapshot;
    await pushState(URL_, 'tok', snap);
    const payloads = f.mock.calls.map((c) => JSON.parse(String(c[1].body)).payload);
    expect(payloads[0]).toEqual({ action: 'setEmail', token: 'tok', enabled: true, hour: 18, minute: 0, tz: 'Asia/Dhaka' });
    expect(payloads[1]).toEqual({ action: 'sendTestEmail', token: 'tok' });
    expect(payloads[2]).toEqual({ action: 'ackInbox', token: 'tok', ids: ['a', 'b'] });
    expect(payloads[3]).toEqual({ action: 'pushState', token: 'tok', ...snap });
  });

  it('getScriptVersion reads the ping version, or null when unreachable or not the script', async () => {
    const f = stubFetch(() => reply({ status: 'ok', version: 3 }));
    expect(await getScriptVersion(URL_)).toBe(3);
    expect(sentBody(f)).toEqual({ scriptUrl: URL_, action: 'ping', method: 'GET' });
    stubFetch(() => reply({ status: 'ok' }));
    expect(await getScriptVersion(URL_)).toBe(1);
    stubFetch(() => reply({ error: 'x' }, 502));
    expect(await getScriptVersion(URL_)).toBeNull();
    stubFetch(() => Promise.reject(new Error('down')));
    expect(await getScriptVersion(URL_)).toBeNull();
  });
});

describe('phoneApi: failures are plain, coded and marked retryable', () => {
  it("passes the proxy's code and sentence on, and says the call is worth retrying (Google unreachable)", async () => {
    stubFetch(() => reply({ status: 'error', code: 'unreachable', error: 'WorkPulse could not reach Google from this computer.' }, 502));
    const r = await pullInbox(URL_, 't');
    expect(r).toEqual({ ok: false, code: 'unreachable', message: 'WorkPulse could not reach Google from this computer.', retryable: true });
  });
  it('treats a Google web page (script not deployed for Anyone) as not retryable', async () => {
    stubFetch(() => reply({ status: 'error', code: 'not_deployed', error: 'Google returned a web page instead of the script response.' }, 502));
    const r = await pullInbox(URL_, 't');
    expect(r.code).toBe('not_deployed');
    expect(r.retryable).toBeUndefined();
  });
  it('gives up on a call that never answers, with a timeout code, instead of waiting forever', async () => {
    vi.useFakeTimers();
    stubFetch(() => new Promise(() => {}));
    const run = pullInbox(URL_, 't');
    await vi.advanceTimersByTimeAsync(41_000); // pullInbox's limit is the server's 35 s plus 5 s
    const r = await run;
    vi.useRealTimers();
    expect(r).toMatchObject({ ok: false, code: 'timeout', retryable: true });
    expect(r.message).toMatch(/did not answer in time/);
  });
  it('gives the backup calls a longer limit than a normal call', async () => {
    vi.useFakeTimers();
    stubFetch(() => new Promise(() => {}));
    let settled = false;
    const run = saveBackupToSheet(URL_, 't', 'x', { counts: { logs: 0, tasks: 0, projects: 0 }, exportedAt: 'x' }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50_000); // 140 s server limit plus 5 s
    expect((await run).code).toBe('timeout');
    vi.useRealTimers();
  });
  it('marks a local-server failure as retryable with its own code', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const r = await pullInbox(URL_, 't');
    expect(r).toMatchObject({ ok: false, code: 'server_down', retryable: true });
  });
  it('does not mark a wrong PIN as retryable', async () => {
    stubFetch(() => reply({ status: 'error', code: 'bad_pin' }));
    expect((await setPhonePin(URL_, '1', {})).retryable).toBeUndefined();
  });
  it('treats a busy script (code busy from version 6) as retryable', async () => {
    stubFetch(() => reply({ status: 'error', code: 'busy', message: 'The Sheet is busy.' }));
    expect(await pullInbox(URL_, 't')).toMatchObject({ ok: false, code: 'busy', retryable: true });
  });
});

describe('probeScript', () => {
  it('reads the version of the script', async () => {
    stubFetch(() => reply({ status: 'ok', version: 5 }));
    expect(await probeScript(URL_)).toEqual({ kind: 'ok', version: 5 });
  });
  it('reads a script from before versions as version 1', async () => {
    stubFetch(() => reply({ status: 'ok' }));
    expect(await probeScript(URL_)).toEqual({ kind: 'ok', version: 1 });
  });
  it('says there is no URL without asking', async () => {
    const f = stubFetch(() => reply({ status: 'ok' }));
    expect(await probeScript('  ')).toEqual({ kind: 'no-url' });
    expect(f).not.toHaveBeenCalled();
  });
  it('says not reachable (a problem of the moment, not an old version) for no connection, a timeout or a local server problem', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect((await probeScript(URL_)).kind).toBe('unreachable');
    stubFetch(() => reply({ status: 'error', code: 'unreachable', error: 'Could not reach Google.' }, 502));
    expect(await probeScript(URL_)).toEqual({ kind: 'unreachable', message: 'Could not reach Google.' });
    stubFetch(() => reply({ status: 'error', code: 'timeout', error: 'Google did not answer in time.' }, 504));
    expect((await probeScript(URL_)).kind).toBe('unreachable');
  });
  it('says the URL is not WorkPulse\'s script when Google answers with a page or the answer is not the script\'s', async () => {
    stubFetch(() => reply({ status: 'error', code: 'not_deployed', error: 'Google returned a web page.' }, 502));
    expect((await probeScript(URL_)).kind).toBe('not-workpulse');
    stubFetch(() => reply({ hello: 'world' }));
    expect((await probeScript(URL_)).kind).toBe('not-workpulse');
  });
});

describe('phoneApi: sheet backup', () => {
  const meta = { counts: { logs: 2, tasks: 1, projects: 1 }, exportedAt: '2026-11-12T08:00:00.000Z' };

  it('saveBackupToSheet posts the token and the text in the body, never in the URL', async () => {
    const f = stubFetch(() => reply({ status: 'ok', version: 2, savedAt: 'x' }));
    const r = await saveBackupToSheet(URL_, 'tok123', '{"logs":[]}', meta);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ version: 2 });
    expect(sentBody(f)).toEqual({
      scriptUrl: URL_,
      action: 'saveBackup',
      method: 'POST',
      payload: { action: 'saveBackup', token: 'tok123', backup: '{"logs":[]}', meta },
    });
    expect(String(f.mock.calls[0][0])).not.toContain('tok123');
    expect(sentBody(f).scriptUrl).not.toContain('tok123');
  });

  it("saveBackupToSheet passes the script's plain message on (too large, bad token)", async () => {
    stubFetch(() => reply({ status: 'error', code: 'bad_request', message: 'This backup is larger than 20 MB.' }));
    expect(await saveBackupToSheet(URL_, 't', 'x', meta)).toEqual({ ok: false, message: 'This backup is larger than 20 MB.', code: 'bad_request' });
    stubFetch(() => reply({ status: 'error', code: 'bad_token' }));
    const r = await saveBackupToSheet(URL_, 't', 'x', meta);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Reset phone access');
  });

  it('getBackupInfo returns clean versions and drops odd rows', async () => {
    const f = stubFetch(() =>
      reply({ status: 'ok', versions: [{ version: 3, savedAt: 'a', counts: { logs: 5, tasks: 'x' } }, { nope: 1 }, null] }),
    );
    const r = await getBackupInfo(URL_, 'tok');
    expect(r.data?.versions).toEqual([{ version: 3, savedAt: 'a', counts: { logs: 5, tasks: 0, projects: 0 } }]);
    expect(sentBody(f).payload).toEqual({ action: 'backupInfo', token: 'tok' });
  });

  it('getBackupInfo from an older script (unknown action) is a plain failure', async () => {
    stubFetch(() => reply({ status: 'ok', message: 'Unknown action' }));
    const r = await getBackupInfo(URL_, 'tok');
    expect(r.ok).toBe(true);
    expect(r.data?.versions).toEqual([]);
  });

  it('loadBackupFromSheet sends the version only when asked and checks the answer', async () => {
    let f = stubFetch(() => reply({ status: 'ok', backup: '{"a":1}', savedAt: 's' }));
    expect((await loadBackupFromSheet(URL_, 'tok')).data).toEqual({ backup: '{"a":1}', savedAt: 's' });
    expect(sentBody(f).payload).toEqual({ action: 'loadBackup', token: 'tok' });
    f = stubFetch(() => reply({ status: 'ok', backup: '{"a":1}', savedAt: 's' }));
    await loadBackupFromSheet(URL_, 'tok', 4);
    expect(sentBody(f).payload).toEqual({ action: 'loadBackup', token: 'tok', version: 4 });
    stubFetch(() => reply({ status: 'ok' }));
    expect((await loadBackupFromSheet(URL_, 'tok')).ok).toBe(false);
    stubFetch(() => reply({ status: 'error', code: 'bad_request', message: 'That saved copy in the Sheet is incomplete.' }));
    expect((await loadBackupFromSheet(URL_, 'tok', 2)).message).toBe('That saved copy in the Sheet is incomplete.');
  });

  it('a network failure becomes a plain sentence', async () => {
    stubFetch(() => {
      throw new Error('Failed to fetch');
    });
    const r = await saveBackupToSheet(URL_, 't', 'x', meta);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain('Failed to fetch');
  });
});

describe('phoneApi: history and standup emails (script version 6)', () => {
  const day = { kind: 'day', date: '2026-11-11' } as const;

  it('saveHistory posts the token in the body with the right action and checks the answer', async () => {
    const f = stubFetch(() => reply({ status: 'ok', days: 1, standups: 0 }));
    const r = await saveHistory(URL_, 'tok123', { days: [{ date: '2026-11-11', workedMinutes: 480, loggedMinutes: 400, logCount: 3 }] });
    expect(r).toMatchObject({ ok: true, data: { days: 1, standups: 0 } });
    expect(sentBody(f)).toMatchObject({ action: 'saveHistory', payload: { action: 'saveHistory', token: 'tok123', standups: [] } });
    expect(String(f.mock.calls[0][0])).not.toContain('tok123');
  });

  it('a script older than version 6 answers any action with ok; that is reported as an old script', async () => {
    stubFetch(() => reply({ status: 'ok', message: 'Action completed' }));
    expect(await saveHistory(URL_, 't', {})).toMatchObject({ ok: false, code: 'script_old' });
    expect(await sendDayEmail(URL_, 't', day)).toMatchObject({ ok: false, code: 'script_old' });
    expect(await getEmailStatus(URL_, 't')).toMatchObject({ ok: false, code: 'script_old' });
    expect(await cancelDayEmail(URL_, 't', day)).toMatchObject({ ok: false, code: 'script_old' });
    expect(HISTORY_SCRIPT_VERSION).toBe(6);
  });

  it('sendDayEmail sends the target, delay and request id; a failure keeps the script sentence', async () => {
    const f = stubFetch(() => reply({ status: 'ok', state: 'pending', key: 'week|2026-11-09|2026-11-15' }));
    const r = await sendDayEmail(URL_, 'tok', { kind: 'week', from: '2026-11-09', to: '2026-11-15' }, { delayMinutes: 20, requestId: 'r1' });
    expect(r.data?.state).toBe('pending');
    expect(sentBody(f).payload).toEqual({ action: 'sendDayEmail', token: 'tok', kind: 'week', from: '2026-11-09', to: '2026-11-15', delayMinutes: 20, requestId: 'r1' });
    stubFetch(() => reply({ status: 'error', code: 'mail_failed', message: 'Google has reached its daily limit.' }));
    expect(await sendDayEmail(URL_, 'tok', day)).toEqual({ ok: false, code: 'mail_failed', message: 'Google has reached its daily limit.' });
  });

  it('getEmailStatus sends keys and drops odd rows; cancel returns the flag; busy is retryable', async () => {
    const f = stubFetch(() => reply({ status: 'ok', items: [{ key: 'k', state: 'sent', tries: 1 }, { nope: 1 }, null] }));
    const r = await getEmailStatus(URL_, 'tok', [day]);
    expect(r.data?.items).toEqual([{ key: 'k', state: 'sent', tries: 1 }]);
    expect(sentBody(f).payload.keys).toEqual([dayEmailKey(day)]);
    expect(dayEmailKey(day)).toBe('day|2026-11-11|2026-11-11');
    stubFetch(() => reply({ status: 'ok', cancelled: true }));
    expect((await cancelDayEmail(URL_, 'tok', day)).data?.cancelled).toBe(true);
    stubFetch(() => reply({ status: 'error', code: 'busy', message: 'The Sheet is busy with another update.' }));
    expect(await cancelDayEmail(URL_, 'tok', day)).toMatchObject({ ok: false, code: 'busy', retryable: true });
  });
});
