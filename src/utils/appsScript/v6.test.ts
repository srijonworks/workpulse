import { describe, it, expect, beforeAll } from 'vitest';
import { createScriptHarness, type ScriptHarness } from '../../test/appsScriptHarness';

beforeAll(() => {
  process.env.TZ = 'Asia/Dhaka';
});

const PIN = '1234';

function setup(): { h: ScriptHarness; token: string } {
  const h = createScriptHarness();
  const r = h.call('setPin', { pin: PIN });
  expect(r.status).toBe('ok');
  return { h, token: r.token as string };
}

const log = (id: string, over: Record<string, unknown> = {}) => ({
  id, createdAt: '2026-11-11T04:00:00.000Z', date: '2026-11-11', time: '10:00', projectName: 'Alpha', description: `Log ${id}`, status: 'completed', durationMinutes: 30, ...over,
});

const standup = (over: Record<string, unknown> = {}) => ({
  id: 'sd-day-2026-11-11', kind: 'day', from: '2026-11-11', to: '2026-11-11', text: 'Yesterday: pump fixed.\nToday: report.', writer: 'claude', createdAt: '2026-11-11T11:00:00.000Z', editedAt: '', ...over,
});

describe('script v6: log writes under the lock', () => {
  it('appendLog and batchSync take the lock with tryLock and release it', () => {
    const { h } = setup();
    const before = h.lockCalls;
    h.call('appendLog', { log: log('log-1') });
    expect(h.lockCalls).toBeGreaterThan(before);
    expect(h.lockHeld).toBe(false);
    const mid = h.lockCalls;
    h.call('batchSync', { logs: [log('log-2'), log('log-3')] });
    expect(h.lockCalls).toBeGreaterThan(mid);
    expect(h.lockHeld).toBe(false);
  });

  it('a contended lock returns busy with a plain sentence and writes nothing', () => {
    const { h } = setup();
    h.contendLock(true);
    const a = h.call('appendLog', { log: log('log-1') });
    const b = h.call('batchSync', { logs: [log('log-2')] });
    for (const r of [a, b]) {
      expect(r).toMatchObject({ status: 'error', code: 'busy' });
      expect(r.message).toMatch(/busy/i);
      expect(r.detail).toContain('lock');
    }
    expect(h.sheets.WorkPulse_Logs).toBeUndefined();
  });

  it('each Id appears once after a busy answer and a retry (and after a repeat)', () => {
    const { h } = setup();
    h.call('appendLog', { log: log('log-1') });
    h.contendLock(true);
    expect(h.call('batchSync', { logs: [log('log-1', { description: 'Edited' }), log('log-2')] }).code).toBe('busy');
    h.contendLock(false);
    expect(h.call('batchSync', { logs: [log('log-1', { description: 'Edited' }), log('log-2')] })).toMatchObject({ status: 'ok', syncedCount: 2 });
    expect(h.call('batchSync', { logs: [log('log-1', { description: 'Edited' }), log('log-2'), log('log-2')] }).status).toBe('ok');
    const ids = h.sheets.WorkPulse_Logs.slice(1).map((r) => r[11]);
    expect(ids.sort()).toEqual(['log-1', 'log-2']);
    expect(h.sheets.WorkPulse_Logs[1][4]).toBe('Edited');
  });

  it('an unexpected error is a plain sentence with the technical text in detail', () => {
    const { h } = setup();
    const r = h.call('appendLog');
    expect(r).toMatchObject({ status: 'error', code: 'error' });
    expect(r.message).toMatch(/^The Sheet script could not finish/);
    expect(r.detail).toContain('No log payload');
  });
});

describe('script v6: Origin column', () => {
  it('writes auto in column 13 and leaves other logs empty', () => {
    const { h } = setup();
    h.call('batchSync', { logs: [log('log-1', { origin: 'auto' }), log('log-2'), log('log-3', { origin: 'weird' })] });
    const rows = h.sheets.WorkPulse_Logs;
    expect(rows[0][12]).toBe('Origin');
    expect(rows.slice(1).map((r) => [r[11], r[12]])).toEqual([['log-1', 'auto'], ['log-2', ''], ['log-3', '']]);
  });

  it('upgrades an old 12-column tab without moving or losing data', () => {
    const { h } = setup();
    h.run('getOrCreateLogsSheet');
    const rows = h.sheets.WorkPulse_Logs;
    rows[0].length = 12;
    rows[0][12] = '';
    rows.push(['t', '2026-11-01', '09:00', 'Alpha', 'Old', 'completed', '', '', 10, 0, 'None', 'log-old']);
    h.call('appendLog', { log: log('log-new', { origin: 'auto' }) });
    expect(rows[0].slice(0, 13)).toEqual(['Timestamp', 'Date', 'Time', 'Project', 'Description', 'Status', 'Tags', 'Link', 'Duration_Minutes', 'Energy_Rating', 'Proof_Attached', 'Id', 'Origin']);
    expect(rows[1][4]).toBe('Old');
    expect(rows[1][11]).toBe('log-old');
    expect(rows[2][12]).toBe('auto');
  });

  it('pushState writes Origin to WorkPulse_Recent and upgrades an old tab', () => {
    const { h, token } = setup();
    const snap = {
      tasks: [], workdays: {}, projects: [], workdayHours: 8, tz: 'Asia/Dhaka', deviceId: 'd', today: '2026-11-11',
      logs: [
        { id: 'a', date: '2026-11-11', time: '09:00', project: 'Alpha', projectId: 'p1', description: 'x', status: 'completed', minutes: 5, origin: 'auto' },
        { id: 'b', date: '2026-11-11', time: '10:00', project: 'Alpha', projectId: 'p1', description: 'y', status: 'completed', minutes: 5 },
      ],
    };
    h.sheets.WorkPulse_Recent = [['Id', 'Date', 'Time', 'Project', 'ProjectId', 'Description', 'Status', 'Minutes', 'SubTasks']];
    expect(h.call('pushState', { token, ...snap }).status).toBe('ok');
    expect(h.sheets.WorkPulse_Recent[0][9]).toBe('Origin');
    expect(h.sheets.WorkPulse_Recent.slice(1).map((r) => r[9])).toEqual(['auto', '']);
  });
});

describe('script v6: saveHistory', () => {
  const day = { date: '2026-11-11', clockIn: '2026-11-11T03:00:00.000Z', clockOut: '2026-11-11T11:00:00.000Z', workedMinutes: 480, loggedMinutes: 400, logCount: 5, closedAt: '2026-11-11T11:01:00.000Z' };

  it('adds and then updates rows by date and by id', () => {
    const { h, token } = setup();
    expect(h.call('saveHistory', { token, days: [day], standups: [standup()] })).toMatchObject({ status: 'ok', days: 1, standups: 1 });
    expect(h.call('saveHistory', { token, days: [{ ...day, loggedMinutes: 420 }, { ...day, date: '2026-11-10' }], standups: [standup({ text: 'Edited', editedAt: 'x' })] }).status).toBe('ok');
    expect(h.sheets.WorkPulse_DayHistory[0]).toEqual(['Date', 'ClockIn', 'ClockOut', 'WorkedMinutes', 'LoggedMinutes', 'LogCount', 'ClosedAt']);
    expect(h.sheets.WorkPulse_DayHistory).toHaveLength(3);
    expect(h.sheets.WorkPulse_DayHistory[1][4]).toBe(420);
    expect(h.sheets.WorkPulse_Standups[0]).toEqual(['Id', 'Kind', 'From', 'To', 'Text', 'Writer', 'CreatedAt', 'EditedAt']);
    expect(h.sheets.WorkPulse_Standups).toHaveLength(2);
    expect(h.sheets.WorkPulse_Standups[1][4]).toBe('Edited');
  });

  it('needs the token, rejects bad rows and answers busy without writing', () => {
    const { h, token } = setup();
    expect(h.call('saveHistory', { token: 'nope', days: [day] })).toMatchObject({ status: 'error', code: 'bad_token' });
    expect(h.call('saveHistory', { token, days: [{ ...day, date: 'tomorrow' }] }).code).toBe('bad_request');
    expect(h.call('saveHistory', { token, standups: [standup({ kind: 'month' })] }).code).toBe('bad_request');
    h.contendLock(true);
    expect(h.call('saveHistory', { token, days: [day] }).code).toBe('busy');
    expect(h.sheets.WorkPulse_DayHistory).toBeUndefined();
  });
});

describe('script v6: standup emails', () => {
  const DAY = { kind: 'day', date: '2026-11-11' };
  const KEY = 'day|2026-11-11|2026-11-11';

  function ready() {
    const s = setup();
    s.h.call('saveHistory', { token: s.token, standups: [standup(), standup({ id: 'sd-week', kind: 'week', from: '2026-11-09', to: '2026-11-15', text: 'Week: lots done.' })] });
    return s;
  }

  it('sends the text and a Sheet link once per key', () => {
    const { h, token } = ready();
    expect(h.call('sendDayEmail', { token, ...DAY, requestId: 'r1' })).toMatchObject({ status: 'ok', state: 'sent', key: KEY });
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].to).toBe('owner@gmail.com');
    expect(h.mails[0].subject).toContain('Wed 11 Nov');
    expect(h.mails[0].body).toContain('Yesterday: pump fixed.');
    expect(h.mails[0].body).toContain('https://docs.google.com/spreadsheets/d/FAKE_ID/edit');
    expect(h.mails[0].htmlBody).toContain('Open your WorkPulse Sheet');
    // the designed day email (as the evening one), for that date, with the standup as a section
    expect(h.mails[0].htmlBody).toContain('Wednesday 11 November');
    expect(h.mails[0].htmlBody).toContain('Standup');
    expect(h.mails[0].htmlBody).toContain('when your day closed');
    expect(h.call('sendDayEmail', { token, ...DAY, requestId: 'r2' })).toMatchObject({ state: 'sent', duplicate: true });
    expect(h.mails).toHaveLength(1);
    expect(h.call('sendDayEmail', { token, kind: 'week', from: '2026-11-09', to: '2026-11-15' }).state).toBe('sent');
    expect(h.mails).toHaveLength(2);
    expect(h.mails[1].subject).toContain('week');
  });

  it('draws the standup marks as HTML and groups bullets by project', () => {
    const { h, token } = ready();
    const text = '*What I completed today:*\n- *hims:* Fixed <stock>\n- *idim:* Report\n- *HIMS:* Billing cap\n\n*Blockers:*\nNone';
    h.call('saveHistory', { token, standups: [standup({ text, editedAt: 'z' })] });
    expect(h.call('sendDayEmail', { token, ...DAY }).state).toBe('sent');
    const html = h.mails[0].htmlBody as string;
    expect(html).not.toContain('*hims:*');
    expect(html).not.toContain('<stock>');
    expect(html).toContain('Fixed &lt;stock&gt;');
    expect(html).toMatch(/What I completed today:<\/div>/);
    // one hims group holding both of its bullets, before idim
    expect(html.match(/>hims<\/div>/g)).toHaveLength(1);
    expect(html.indexOf('>hims</div>')).toBeLessThan(html.indexOf('>idim</div>'));
    expect(html.indexOf('Billing cap')).toBeLessThan(html.indexOf('>idim</div>'));
    const body = h.mails[0].body as string;
    expect(body).toContain('STANDUP\nWHAT I COMPLETED TODAY:\nhims\n  - Fixed ‹stock›\n  - Billing cap\nidim\n  - Report');
  });

  it('the evening email has no standup section', () => {
    const { h } = ready();
    const mail = h.run('buildEveningEmail', {
      date: '2026-11-11', tz: 'Asia/Dhaka', now: '2026-11-11T12:00:00.000Z', tasks: [], logs: [],
      workday: { clockIn: '2026-11-11T03:00:00.000Z' }, workdayHours: 8, pushedAt: '', pendingPhoneCount: 0,
    }) as { html: string; skip: boolean };
    expect(mail.skip).toBe(false);
    expect(mail.html).not.toContain('>Standup<');
  });

  it('sends nothing when the standup text is empty or missing', () => {
    const { h, token } = ready();
    h.call('saveHistory', { token, standups: [standup({ text: '   ', editedAt: 'z' })] });
    expect(h.call('sendDayEmail', { token, ...DAY })).toMatchObject({ status: 'ok', state: 'skipped' });
    expect(h.call('sendDayEmail', { token, kind: 'day', date: '2026-11-12' }).state).toBe('skipped');
    expect(h.mails).toHaveLength(0);
    expect(h.call('emailStatus', { token }).items).toEqual([]);
  });

  it('needs the token and a valid target', () => {
    const { h, token } = ready();
    expect(h.call('sendDayEmail', { token: 'x', ...DAY }).code).toBe('bad_token');
    expect(h.call('sendDayEmail', { token, kind: 'month', date: '2026-11-11' }).code).toBe('bad_request');
    expect(h.call('sendDayEmail', { token, kind: 'week', from: '2026-11-15', to: '2026-11-09' }).code).toBe('bad_request');
    expect(h.call('sendDayEmail', { token, ...DAY, delayMinutes: -5 }).code).toBe('bad_request');
    expect(h.mails).toHaveLength(0);
  });

  it('a delay makes a one-off trigger that sends once, then deletes itself', () => {
    const { h, token } = ready();
    const r = h.call('sendDayEmail', { token, ...DAY, delayMinutes: 30 });
    expect(r).toMatchObject({ status: 'ok', state: 'pending', key: KEY });
    expect(h.mails).toHaveLength(0);
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({ fn: 'sendEveningEmail', afterMs: 30 * 60000 });
    // A second request while waiting does not make a second trigger or a second mail.
    expect(h.call('sendDayEmail', { token, ...DAY, delayMinutes: 30 })).toMatchObject({ state: 'pending', duplicate: true });
    expect(h.triggers).toHaveLength(1);
    expect(h.fireDueTriggers()).toBe(0);
    h.setNow(new Date(Date.parse('2026-11-11T06:00:00Z') + 31 * 60000));
    expect(h.fireDueTriggers()).toBe(1);
    expect(h.mails).toHaveLength(1);
    expect(h.triggers).toHaveLength(0);
    expect(h.fireDueTriggers()).toBe(0);
    expect(h.call('emailStatus', { token, keys: [KEY] }).items[0]).toMatchObject({ key: KEY, state: 'sent', tries: 1 });
    expect(h.call('sendDayEmail', { token, ...DAY }).duplicate).toBe(true);
    expect(h.mails).toHaveLength(1);
  });

  it('a one-off trigger does not disturb the daily evening-email trigger', () => {
    const { h, token } = ready();
    expect(h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: 'Asia/Dhaka' }).status).toBe('ok');
    h.call('sendDayEmail', { token, ...DAY, delayMinutes: 10 });
    expect(h.triggers).toHaveLength(2);
    expect(h.call('setEmail', { token, enabled: true, hour: 19, minute: 0, tz: 'Asia/Dhaka' }).status).toBe('ok');
    expect(h.triggers.map((t) => t.afterMs !== undefined)).toEqual(expect.arrayContaining([true, false]));
    expect(h.triggers).toHaveLength(2);
  });

  it('cancel removes the waiting email and its trigger; a sent email stays sent', () => {
    const { h, token } = ready();
    h.call('sendDayEmail', { token, ...DAY, delayMinutes: 30 });
    expect(h.call('cancelDayEmail', { token, ...DAY })).toMatchObject({ status: 'ok', cancelled: true });
    expect(h.triggers).toHaveLength(0);
    h.setNow(new Date(Date.parse('2026-11-11T06:00:00Z') + 60 * 60000));
    expect(h.fireDueTriggers()).toBe(0);
    expect(h.mails).toHaveLength(0);
    expect(h.call('emailStatus', { token, keys: [KEY] }).items).toEqual([]);
    expect(h.call('cancelDayEmail', { token, ...DAY }).cancelled).toBe(false);
    h.call('sendDayEmail', { token, ...DAY });
    expect(h.call('cancelDayEmail', { token, ...DAY })).toMatchObject({ cancelled: false, state: 'sent' });
    expect(h.call('cancelDayEmail', { token: 'x', ...DAY }).code).toBe('bad_token');
  });

  it('a mail failure is recorded and retried at most 3 times, never sending twice', () => {
    const { h, token } = ready();
    h.failMail('Service unavailable');
    const first = h.call('sendDayEmail', { token, ...DAY });
    expect(first).toMatchObject({ status: 'error', code: 'mail_failed', state: 'failed', tries: 1, willRetry: true });
    expect(first.message).toMatch(/could not send/);
    expect(h.call('emailStatus', { token }).items[0]).toMatchObject({ state: 'failed', tries: 1, error: 'mail' });
    h.call('sendDayEmail', { token, ...DAY });
    h.call('sendDayEmail', { token, ...DAY });
    // The third try was the last: further requests do not try again.
    h.failMail(null);
    expect(h.call('sendDayEmail', { token, ...DAY })).toMatchObject({ status: 'error', state: 'failed' });
    expect(h.mails).toHaveLength(0);
    expect(h.call('emailStatus', { token }).items[0]).toMatchObject({ state: 'failed', tries: 3, willRetry: false });
  });

  it('a failure then success sends exactly once', () => {
    const { h, token } = ready();
    h.failMail('boom');
    h.call('sendDayEmail', { token, ...DAY });
    h.failMail(null);
    expect(h.call('sendDayEmail', { token, ...DAY }).state).toBe('sent');
    expect(h.call('sendDayEmail', { token, ...DAY }).duplicate).toBe(true);
    expect(h.mails).toHaveLength(1);
    expect(h.call('emailStatus', { token }).items[0]).toMatchObject({ state: 'sent', tries: 2 });
  });

  it('a spent daily quota is recorded as quota', () => {
    const { h, token } = ready();
    h.setMailQuota(0);
    const r = h.call('sendDayEmail', { token, ...DAY });
    expect(r).toMatchObject({ status: 'error', code: 'mail_failed' });
    expect(r.message).toMatch(/daily limit/);
    expect(h.call('emailStatus', { token }).items[0]).toMatchObject({ state: 'failed', error: 'quota' });
    expect(h.mails).toHaveLength(0);
  });

  it('a delayed email that fails is tried again by a new timer, at most 3 times in all', () => {
    const { h, token } = ready();
    h.failMail('down');
    h.call('sendDayEmail', { token, ...DAY, delayMinutes: 5 });
    let now = Date.parse('2026-11-11T06:00:00Z');
    for (let i = 0; i < 6; i++) {
      now += 11 * 60000;
      h.setNow(new Date(now));
      h.fireDueTriggers();
    }
    expect(h.triggers).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
    expect(h.call('emailStatus', { token }).items[0]).toMatchObject({ state: 'failed', tries: 3, willRetry: false });
  });

  it('the status stays under 9 KB however many days are sent', () => {
    const { h, token } = setup();
    for (let i = 1; i <= 28; i++) {
      const date = `2026-10-${String(i).padStart(2, '0')}`;
      h.call('saveHistory', { token, standups: [standup({ id: `sd-${date}`, from: date, to: date })] });
      for (let k = 0; k < 6; k++) h.call('sendDayEmail', { token, kind: 'day', date });
    }
    for (let i = 1; i <= 28; i++) {
      const date = `2026-09-${String(i).padStart(2, '0')}`;
      h.call('saveHistory', { token, standups: [standup({ id: `sd-${date}`, from: date, to: date })] });
      h.call('sendDayEmail', { token, kind: 'day', date });
    }
    expect(Buffer.byteLength(h.props.emailLog, 'utf8')).toBeLessThan(9 * 1024);
    // Recent keys survive, so they are still never sent twice.
    const mailsBefore = h.mails.length;
    h.call('sendDayEmail', { token, kind: 'day', date: '2026-09-28' });
    expect(h.mails).toHaveLength(mailsBefore);
  });

  it('answers busy when the lock stays taken, and sends nothing', () => {
    const { h, token } = ready();
    h.contendLock(true);
    expect(h.call('sendDayEmail', { token, ...DAY })).toMatchObject({ status: 'error', code: 'busy' });
    expect(h.call('cancelDayEmail', { token, ...DAY }).code).toBe('busy');
    expect(h.mails).toHaveLength(0);
  });
});

describe('script v6: phoneAddLog', () => {
  const PL = { text: '  Fixed the pump  ', projectId: 'p1', time: '09:30', minutes: 45, day: 'yesterday' };

  function withProjects() {
    const s = setup();
    s.h.call('pushState', { token: s.token, tasks: [], logs: [], workdays: {}, projects: [{ id: 'p1', name: 'Alpha', color: '#f00' }], workdayHours: 8, tz: 'Asia/Dhaka', deviceId: 'd', today: '2026-11-11' });
    return s;
  }

  it('needs the PIN and takes the lock', () => {
    const { h } = withProjects();
    expect(h.run('phoneAddLog', '0000', PL)).toMatchObject({ ok: false, code: 'bad_pin' });
    const before = h.lockCalls;
    const r = h.run('phoneAddLog', PIN, PL);
    expect(r.ok).toBe(true);
    expect(h.lockCalls).toBeGreaterThan(before);
    expect(h.lockHeld).toBe(false);
    expect(r.log).toMatchObject({ date: '2026-11-10', time: '09:30', project: 'Alpha', description: 'Fixed the pump', minutes: 45 });
  });

  it('writes to WorkPulse_Logs and WorkPulse_Recent with the user date', () => {
    const { h } = withProjects();
    const t = h.run('phoneAddLog', PIN, { ...PL, day: 'today' });
    expect(t.log.date).toBe('2026-11-11');
    h.run('phoneAddLog', PIN, PL);
    const logs = h.sheets.WorkPulse_Logs.slice(1);
    expect(logs).toHaveLength(2);
    expect(logs[1][4]).toBe('Fixed the pump');
    expect(logs[1][8]).toBe(45);
    expect(String(logs[1][11])).toMatch(/^phone-log-/);
    expect(h.sheets.WorkPulse_Recent.slice(1).map((r) => r[5])).toEqual(['Fixed the pump', 'Fixed the pump']);
  });

  it('rejects bad input in plain sentences', () => {
    const { h } = withProjects();
    for (const bad of [{ text: ' ' }, { day: 'tomorrow' }, { time: '25:00' }, { time: '9:30' }, { minutes: 0 }, { minutes: 1.5 }, { minutes: 5000 }, { minutes: 'x' }]) {
      const r = h.run('phoneAddLog', PIN, { ...PL, ...bad });
      expect(r).toMatchObject({ ok: false, code: 'bad_request' });
      expect(r.message.length).toBeGreaterThan(10);
    }
    expect(h.sheets.WorkPulse_Logs).toBeUndefined();
  });
});
