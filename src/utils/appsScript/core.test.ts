import { describe, it, expect, beforeAll } from 'vitest';
import { createScriptHarness, zonedTime, type ScriptHarness } from '../../test/appsScriptHarness';
import { GOOGLE_APPS_SCRIPT_CODE } from '../googleAppsScriptTemplate';

beforeAll(() => {
  process.env.TZ = 'Asia/Dhaka';
});

const PIN = '1234';

function withPin(h: ScriptHarness, pin = PIN): string {
  const r = h.call('setPin', { pin });
  expect(r.status).toBe('ok');
  return r.token as string;
}

const snapshot = (over: Record<string, unknown> = {}) => ({
  tasks: [
    { id: 't1', title: 'Write report', projectId: 'p1', project: 'Alpha', dueDate: '2026-11-11', stage: 'planned', trackedMinutes: 12, fromPhone: false },
    { id: 't2', title: 'Done thing', projectId: 'p1', project: 'Alpha', dueDate: '2026-11-10', stage: 'done', trackedMinutes: 30, completedAt: '2026-11-10T08:00:00.000Z', fromPhone: false },
    { id: 't3', title: 'Old pending', projectId: 'p2', project: 'Beta', dueDate: '2026-11-09', stage: 'blocked', trackedMinutes: 0, fromPhone: true },
  ],
  logs: [
    { id: 'log-17000', date: '2026-11-11', time: '09:30', project: 'Alpha', projectId: 'p1', description: 'Standup', status: 'completed', minutes: 15 },
  ],
  workdays: { '2026-11-11': { clockIn: '2026-11-11T03:00:00.000Z' }, '2026-11-10': { clockIn: '2026-11-10T03:05:00.000Z', clockOut: '2026-11-10T11:00:00.000Z' } },
  projects: [
    { id: 'p1', name: 'Alpha', color: '#ff0000' },
    { id: 'p2', name: 'Beta', color: '#00ff00' },
  ],
  workdayHours: 8,
  tz: 'Asia/Dhaka',
  deviceId: 'dev-aaa',
  today: '2026-11-11',
  ...over,
});

describe('script v3: existing behaviour', () => {
  it('ping reports version 7 on GET and POST', () => {
    const h = createScriptHarness();
    expect(h.get({ action: 'ping' })).toMatchObject({ status: 'ok', version: 7 });
    expect(h.get({})).toMatchObject({ status: 'ok', version: 7 });
    expect(h.call('ping')).toMatchObject({ status: 'ok', version: 7 });
  });

  it('appendLog still upserts by Id into the 12 log columns', () => {
    const h = createScriptHarness();
    const log = { id: 'log-1700000000000', createdAt: '2026-11-11T04:00:00.000Z', date: '2026-11-11', time: '10:00', projectName: 'Alpha', description: 'First', status: 'completed', tags: ['a', 'b'], durationMinutes: 30 };
    expect(h.call('appendLog', { log })).toMatchObject({ status: 'ok', id: log.id });
    expect(h.call('appendLog', { log: { ...log, description: 'Edited' } }).status).toBe('ok');
    const rows = h.sheets.WorkPulse_Logs;
    expect(rows[0]).toEqual(['Timestamp', 'Date', 'Time', 'Project', 'Description', 'Status', 'Tags', 'Link', 'Duration_Minutes', 'Energy_Rating', 'Proof_Attached', 'Id', 'Origin']);
    expect(h.run('getOrCreateLogsSheet').getLastRow()).toBe(2);
    expect(rows[1][4]).toBe('Edited');
    expect(rows[1][6]).toBe('a, b');
    expect(rows[1][11]).toBe(log.id);
    expect(h.call('batchSync', { logs: [log, { ...log, id: 'log-1700000000001' }] })).toMatchObject({ status: 'ok', syncedCount: 2 });
    expect(h.run('getOrCreateLogsSheet').getLastRow()).toBe(3);
  });

  it('an unknown action still answers ok and a missing log is an error', () => {
    const h = createScriptHarness();
    expect(h.call('somethingElse')).toMatchObject({ status: 'ok', message: 'Action completed' });
    expect(h.call('appendLog').status).toBe('error');
  });

  it('the page link serves an HtmlOutput with the title and a viewport tag', () => {
    const h = createScriptHarness();
    const out = h.get({ page: 'phone' });
    expect(out.kind).toBe('html');
    expect(out.title).toBe('WorkPulse');
    expect(out.metaTags).toContainEqual({ name: 'viewport', content: 'width=device-width, initial-scale=1' });
  });
});

describe('script v3: PIN and desktop token', () => {
  it('sets a first PIN without a secret and returns a long token; the hash, not the PIN, is stored', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(h.props.pinHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.props.pinHash).toBe(h.run('hashSecret', PIN));
    expect(h.props.tokenHash).toBe(h.run('hashSecret', token));
    expect(JSON.stringify(h.props)).not.toContain(token);
    expect(Object.values(h.props)).not.toContain(PIN);
  });

  it('hashSecret is the SHA-256 hex digest', () => {
    const h = createScriptHarness();
    expect(h.run('hashSecret', 'abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('rejects a PIN that is not 4 digits', () => {
    const h = createScriptHarness();
    for (const pin of ['12', '12345', 'abcd', '', 1234]) {
      expect(h.call('setPin', { pin })).toMatchObject({ status: 'error', code: 'bad_request' });
    }
    expect(h.props.pinHash).toBeUndefined();
  });

  it('changing the PIN needs the token (or the old PIN); a new token replaces the old one', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    expect(h.call('setPin', { pin: '5555' })).toMatchObject({ status: 'error', code: 'bad_token' });
    expect(h.call('setPin', { pin: '5555', token: 'wrong' })).toMatchObject({ status: 'error', code: 'bad_token' });
    expect(String(h.call('setPin', { pin: '5555' }).message)).toContain('Use Reset phone access in Settings (it asks for your current PIN).');

    const r = h.call('setPin', { pin: '5555', token });
    expect(r.status).toBe('ok');
    expect(r.token).not.toBe(token);
    expect(h.run('phoneData', PIN)).toMatchObject({ ok: false, code: 'bad_pin' });
    expect(h.run('phoneData', '5555').ok).toBe(true);
    // the old token stops working
    expect(h.call('pullInbox', { token })).toMatchObject({ status: 'error', code: 'bad_token' });
    expect(h.call('pullInbox', { token: r.token }).status).toBe('ok');

    const r2 = h.call('setPin', { pin: '6666', oldPin: '5555' });
    expect(r2.status).toBe('ok');
    expect(h.run('phoneData', '6666').ok).toBe(true);
    expect(h.call('setPin', { pin: '7777', oldPin: '0000' })).toMatchObject({ status: 'error', code: 'bad_pin' });
  });

  it('resetAccess with the current PIN issues a new token and PIN', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    expect(h.call('resetAccess', { pin: '0000', newPin: '4321' })).toMatchObject({ status: 'error', code: 'bad_pin' });
    const r = h.call('resetAccess', { pin: PIN, newPin: '4321' });
    expect(r.status).toBe('ok');
    expect(r.token.length).toBeGreaterThanOrEqual(32);
    expect(h.call('pullInbox', { token })).toMatchObject({ code: 'bad_token' });
    expect(h.call('pullInbox', { token: r.token }).status).toBe('ok');
    expect(h.run('phoneData', '4321').ok).toBe(true);
  });

  it('every new action without a PIN set answers no_pin or bad_token', () => {
    const h = createScriptHarness();
    expect(h.run('phoneData', PIN)).toMatchObject({ ok: false, code: 'no_pin' });
    expect(h.call('resetAccess', { pin: PIN, newPin: '1111' })).toMatchObject({ code: 'no_pin' });
    for (const a of ['pushState', 'pullInbox', 'ackInbox', 'setEmail', 'sendTestEmail']) {
      expect(h.call(a, { token: 'x' })).toMatchObject({ status: 'error', code: 'bad_token' });
    }
  });

  it('locks PIN checks after 5 wrong PINs for 15 minutes; the desktop token keeps working', () => {
    const start = new Date('2026-11-11T06:00:00Z');
    const h = createScriptHarness({ now: start });
    const token = withPin(h);
    for (let i = 1; i <= 4; i++) {
      const r = h.run('phoneData', '0000');
      expect(r).toMatchObject({ ok: false, code: 'bad_pin', message: 'That PIN is not right.', triesLeft: 5 - i });
    }
    expect(h.run('phoneData', '0000')).toMatchObject({ ok: false, code: 'locked' });
    const locked = h.run('phoneData', PIN);
    expect(locked).toMatchObject({ ok: false, code: 'locked' });
    expect(locked.message).toMatch(/Too many wrong PINs\. Try again in 15 minutes\./);
    expect(locked.lockedUntil).toBe(new Date(start.getTime() + 15 * 60000).toISOString());
    // the PIN-guarded desktop actions are locked too, but not the token ones
    expect(h.call('resetAccess', { pin: PIN, newPin: '9999' })).toMatchObject({ status: 'error', code: 'locked' });
    expect(h.call('pushState', { token, ...snapshot() }).status).toBe('ok');
    expect(h.call('pullInbox', { token }).status).toBe('ok');
    expect(h.props.failCount).toBe('5');

    h.setNow(new Date(start.getTime() + 16 * 60000));
    expect(h.run('phoneData', PIN).ok).toBe(true);
    expect(h.props.failCount).toBeUndefined();
    expect(h.props.lockUntil).toBeUndefined();
    expect(h.run('phoneData', '0000')).toMatchObject({ code: 'bad_pin', triesLeft: 4 });
  });

  it('after a lock ends, one more wrong PIN locks again until a right PIN resets the count', () => {
    const start = new Date('2026-11-11T06:00:00Z');
    const h = createScriptHarness({ now: start });
    withPin(h);
    for (let i = 0; i < 5; i++) h.run('phoneData', '0000');
    h.setNow(new Date(start.getTime() + 16 * 60000));
    expect(h.run('phoneData', '0000')).toMatchObject({ code: 'locked' });
    expect(h.run('phoneData', PIN)).toMatchObject({ code: 'locked' });
  });

  it('setting the PIN with the token clears a lock', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    for (let i = 0; i < 5; i++) h.run('phoneData', '0000');
    expect(h.call('setPin', { pin: '2468', token }).status).toBe('ok');
    expect(h.run('phoneData', '2468').ok).toBe(true);
  });

  it('a token check never touches the failure counter', () => {
    const h = createScriptHarness();
    withPin(h);
    for (let i = 0; i < 10; i++) expect(h.call('pullInbox', { token: 'nope' }).code).toBe('bad_token');
    expect(h.props.failCount).toBeUndefined();
    expect(h.run('phoneData', PIN).ok).toBe(true);
  });
});

describe('script v3: pushState', () => {
  it('writes the state tabs and meta, and a second push replaces the first fully', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    const r = h.call('pushState', { token, ...snapshot() });
    expect(r).toMatchObject({ status: 'ok', deviceChanged: false });

    expect(h.sheets.WorkPulse_Tasks[0]).toEqual(['Id', 'Title', 'Project', 'ProjectId', 'DueDate', 'Stage', 'TrackedMinutes', 'CompletedAt', 'FromPhone']);
    expect(h.sheets.WorkPulse_Days[0]).toEqual(['Date', 'ClockIn', 'ClockOut']);
    expect(h.sheets.WorkPulse_Recent[0]).toEqual(['Id', 'Date', 'Time', 'Project', 'ProjectId', 'Description', 'Status', 'Minutes', 'SubTasks', 'Origin']);
    expect(h.sheets.WorkPulse_Projects[0]).toEqual(['Id', 'Name', 'Color']);
    expect(h.sheets.WorkPulse_Tasks).toHaveLength(4);
    // date columns stay plain text, not Date objects
    expect(h.sheets.WorkPulse_Tasks[1][4]).toBe('2026-11-11');
    expect(h.sheets.WorkPulse_Days.slice(1).map((row) => row[0]).sort()).toEqual(['2026-11-10', '2026-11-11']);
    expect(h.sheets.WorkPulse_Recent[1][1]).toBe('2026-11-11');
    expect(h.sheets.WorkPulse_Recent[1][2]).toBe('09:30');

    const meta = JSON.parse(h.props.meta);
    expect(meta).toMatchObject({ tz: 'Asia/Dhaka', deviceId: 'dev-aaa', workdayHours: 8, today: '2026-11-11', deviceChanged: false });
    expect(meta.pushedAt).toBe('2026-11-11T06:00:00.000Z');

    h.call('pushState', {
      token,
      ...snapshot({ tasks: [{ id: 't9', title: 'Only one', projectId: 'p1', project: 'Alpha', dueDate: '2026-11-12', stage: 'planned', trackedMinutes: 0, fromPhone: false }], logs: [], workdays: {}, projects: [{ id: 'p1', name: 'Alpha', color: '#f00' }] }),
    });
    const d = h.run('phoneData', PIN);
    expect(d.tasks.map((t: any) => t.id)).toEqual(['t9']);
    expect(d.logs).toEqual([]);
    expect(d.workdays).toEqual({});
    expect(d.projects).toEqual([{ id: 'p1', name: 'Alpha', color: '#f00' }]);
  });

  it('a push from a different device sets meta.deviceChanged', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    h.call('pushState', { token, ...snapshot() });
    const r = h.call('pushState', { token, ...snapshot({ deviceId: 'dev-bbb' }) });
    expect(r.deviceChanged).toBe(true);
    expect(JSON.parse(h.props.meta)).toMatchObject({ deviceId: 'dev-bbb', deviceChanged: true });
    expect(h.call('pushState', { token, ...snapshot({ deviceId: 'dev-bbb' }) }).deviceChanged).toBe(false);
  });

  it('rejects a push without lists or a proper date', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    expect(h.call('pushState', { token, ...snapshot({ tasks: 'x' }) })).toMatchObject({ status: 'error', code: 'bad_request' });
    expect(h.call('pushState', { token, ...snapshot({ today: '11/11/2026' }) })).toMatchObject({ status: 'error', code: 'bad_request' });
    expect(h.props.meta).toBeUndefined();
  });

  it('grows the tab when a push has more rows than the sheet', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    const tasks = Array.from({ length: 1200 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, projectId: 'p1', project: 'Alpha', dueDate: '2026-11-11', stage: 'planned', trackedMinutes: 0, fromPhone: false }));
    expect(h.call('pushState', { token, ...snapshot({ tasks }) }).status).toBe('ok');
    expect(h.run('phoneData', PIN).tasks).toHaveLength(1200);
  });
});

describe('script v3: phoneData', () => {
  it('returns open tasks, recent logs, workdays, projects, push time and pending inbox items, all JSON-safe', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    h.call('pushState', { token, ...snapshot() });
    h.run('phoneAddTask', PIN, { title: 'From phone', projectId: 'p2', day: 'today' });
    const d = h.run('phoneData', PIN);
    expect(d.ok).toBe(true);
    expect(d.tasks.map((t: any) => t.id)).toEqual(['t1', 't3']);
    expect(d.tasks[0]).toEqual({ id: 't1', title: 'Write report', project: 'Alpha', projectId: 'p1', dueDate: '2026-11-11', stage: 'planned', trackedMinutes: 12, completedAt: '', fromPhone: false });
    expect(d.tasks[1].fromPhone).toBe(true);
    expect(d.logs).toEqual([{ id: 'log-17000', date: '2026-11-11', time: '09:30', project: 'Alpha', projectId: 'p1', description: 'Standup', status: 'completed', minutes: 15 }]);
    expect(d.workdays).toEqual({
      '2026-11-11': { clockIn: '2026-11-11T03:00:00.000Z', clockOut: '' },
      '2026-11-10': { clockIn: '2026-11-10T03:05:00.000Z', clockOut: '2026-11-10T11:00:00.000Z' },
    });
    expect(d.projects).toHaveLength(2);
    expect(d.pushedAt).toBe('2026-11-11T06:00:00.000Z');
    expect(d.today).toBe('2026-11-11');
    expect(d.workdayHours).toBe(8);
    expect(d.pending).toHaveLength(1);
    expect(d.pending[0]).toMatchObject({ title: 'From phone', projectId: 'p2', projectName: 'Beta', dueDate: '2026-11-11' });
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('works before any push', () => {
    const h = createScriptHarness();
    withPin(h);
    const d = h.run('phoneData', PIN);
    expect(d).toMatchObject({ ok: true, tasks: [], logs: [], workdays: {}, projects: [], pending: [], pushedAt: '', workdayHours: 8 });
  });
});

describe('script v3: phone inbox', () => {
  it("'tomorrow' at 23:30 in Dhaka is the next Dhaka date", () => {
    const h = createScriptHarness({ spreadsheetTz: 'America/New_York', now: zonedTime('Asia/Dhaka', 2026, 11, 11, 23, 30) });
    const token = withPin(h);
    h.call('pushState', { token, ...snapshot() });
    const r = h.run('phoneAddTask', PIN, { title: 'Late idea', projectId: 'p1', day: 'tomorrow' });
    expect(r.ok).toBe(true);
    expect(r.item.dueDate).toBe('2026-11-12');
    expect(h.run('phoneAddTask', PIN, { title: 'Tonight', projectId: 'p1', day: 'today' }).item.dueDate).toBe('2026-11-11');
    expect(r.item.id).toMatch(/^phone-\d{13}-[a-z0-9]+$/);
    expect(r.item).toMatchObject({ title: 'Late idea', projectId: 'p1', projectName: 'Alpha' });
    expect(r.item.createdAt).toBe(zonedTime('Asia/Dhaka', 2026, 11, 11, 23, 30).toISOString());
    // 05:00 in Dhaka is still the previous evening in the Sheet's zone: the user's zone wins.
    h.setNow(zonedTime('Asia/Dhaka', 2026, 11, 12, 5, 0));
    expect(h.run('phoneAddTask', PIN, { title: 'Early', projectId: 'p1', day: 'today' }).item.dueDate).toBe('2026-11-12');
    expect(h.run('phoneData', PIN).today).toBe('2026-11-12');
  });

  it('month and year ends roll over correctly', () => {
    const h = createScriptHarness({ now: zonedTime('Asia/Dhaka', 2026, 12, 31, 22, 0) });
    const token = withPin(h);
    h.call('pushState', { token, ...snapshot() });
    expect(h.run('phoneAddTask', PIN, { title: 'x', projectId: 'p1', day: 'tomorrow' }).item.dueDate).toBe('2027-01-01');
  });

  it('rejects an empty title, cuts long titles to 200 and refuses the 501st pending item', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    h.call('pushState', { token, ...snapshot() });
    expect(h.run('phoneAddTask', PIN, { title: '   ', projectId: 'p1', day: 'today' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(h.run('phoneAddTask', PIN, { title: 'x', projectId: 'p1', day: 'someday' })).toMatchObject({ ok: false, code: 'bad_request' });
    const long = h.run('phoneAddTask', PIN, { title: '  ' + 'a'.repeat(300) + '  ', projectId: 'p1', day: 'today' });
    expect(long.item.title).toHaveLength(200);
    expect(h.run('phoneAddTask', '0000', { title: 'x', projectId: 'p1', day: 'today' })).toMatchObject({ ok: false, code: 'bad_pin' });

    for (let i = 1; i < 500; i++) {
      expect(h.run('phoneAddTask', PIN, { title: `t${i}`, projectId: 'p1', day: 'today' }).ok).toBe(true);
    }
    const full = h.run('phoneAddTask', PIN, { title: 'one too many', projectId: 'p1', day: 'today' });
    expect(full).toMatchObject({ ok: false, code: 'bad_request' });
    expect(h.call('pullInbox', { token }).items).toHaveLength(500);
  });

  it('pullInbox returns pending items; ackInbox marks them taken and ignores unknown ids', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    h.call('pushState', { token, ...snapshot() });
    const a = h.run('phoneAddTask', PIN, { title: 'A', projectId: 'p1', day: 'today' }).item;
    const b = h.run('phoneAddTask', PIN, { title: 'B', projectId: 'nope', day: 'tomorrow' }).item;
    const pulled = h.call('pullInbox', { token });
    expect(pulled.status).toBe('ok');
    expect(pulled.items).toEqual([a, b]);
    expect(Object.keys(pulled.items[0]).sort()).toEqual(['createdAt', 'dueDate', 'id', 'projectId', 'projectName', 'title']);
    expect(b.projectName).toBe('');

    expect(h.call('ackInbox', { token, ids: [a.id, 'phone-unknown'] })).toMatchObject({ status: 'ok', taken: 1 });
    expect(h.call('pullInbox', { token }).items).toEqual([b]);
    expect(h.call('ackInbox', { token, ids: [b.id] }).status).toBe('ok');
    expect(h.call('pullInbox', { token }).items).toEqual([]);
    expect(h.sheets.WorkPulse_Inbox.slice(1).map((r) => r[6])).toEqual(['taken', 'taken']);
    expect(h.call('ackInbox', { token, ids: 'x' })).toMatchObject({ status: 'error', code: 'bad_request' });
  });

  it('task text is stored as data: markup and date-looking titles round-trip unchanged', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    h.call('pushState', { token, ...snapshot() });
    const evil = '<img src=x onerror=1>';
    h.run('phoneAddTask', PIN, { title: evil, projectId: 'p1', day: 'today' });
    h.run('phoneAddTask', PIN, { title: '2026-11-12', projectId: 'p1', day: 'today' });
    h.run('phoneAddTask', PIN, { title: '12:30', projectId: 'p1', day: 'today' });
    expect(h.call('pullInbox', { token }).items.map((i: any) => i.title)).toEqual([evil, '2026-11-12', '12:30']);

    h.call('pushState', { token, ...snapshot({ tasks: [{ id: 't1', title: evil, projectId: 'p1', project: '<b>P</b>', dueDate: '2026-11-11', stage: 'planned', trackedMinutes: 0, fromPhone: false }] }) });
    const d = h.run('phoneData', PIN);
    expect(d.tasks[0].title).toBe(evil);
    expect(d.tasks[0].project).toBe('<b>P</b>');
  });
});

describe('script v3: older logs from WorkPulse_Logs', () => {
  function seedLogs(h: ScriptHarness, tz: string, days: number[]) {
    h.run('getOrCreateLogsSheet');
    // As Sheets stores a typed 'YYYY-MM-DD': a Date at midnight in the spreadsheet zone.
    days.forEach((day, i) => {
      h.sheets.WorkPulse_Logs.push([
        '2026-11-01T00:00:00.000Z', zonedTime(tz, 2026, 10, day), zonedTime(tz, 1899, 12, 30, 9, 15),
        'Alpha', `Log ${day}`, 'completed', '', '', 45, 0, 'None', `log-17000000000${i}`,
      ]);
    });
  }

  for (const tz of ['America/New_York', 'Asia/Tokyo']) {
    it(`normalises Date cells in the spreadsheet zone (${tz}) without shifting a day`, () => {
      const h = createScriptHarness({ spreadsheetTz: tz });
      withPin(h);
      seedLogs(h, tz, [20, 21, 22]);
      const r = h.run('phoneOlderLogs', PIN, '2026-10-22');
      expect(r.ok).toBe(true);
      expect(r.logs.map((l: any) => l.date)).toEqual(['2026-10-21', '2026-10-20']);
      expect(r.logs[0]).toEqual({ id: 'log-170000000001', date: '2026-10-21', time: '09:15', project: 'Alpha', description: 'Log 21', status: 'completed', minutes: 45 });
      expect(r.more).toBe(false);
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    });
  }

  it('returns 14 days at a time with a cursor for the next page', () => {
    const h = createScriptHarness({ spreadsheetTz: 'America/New_York' });
    withPin(h);
    seedLogs(h, 'America/New_York', Array.from({ length: 20 }, (_, i) => i + 1));
    const r = h.run('phoneOlderLogs', PIN, '2026-10-31');
    expect(new Set(r.logs.map((l: any) => l.date)).size).toBe(14);
    expect(r.logs[0].date).toBe('2026-10-20');
    expect(r.nextBefore).toBe('2026-10-07');
    expect(r.more).toBe(true);
    const r2 = h.run('phoneOlderLogs', PIN, r.nextBefore);
    expect(r2.logs.map((l: any) => l.date)).toEqual(['2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01']);
    expect(r2.more).toBe(false);
  });

  it('needs the PIN and a proper date, and copes with no log tab', () => {
    const h = createScriptHarness();
    withPin(h);
    expect(h.run('phoneOlderLogs', '0000', '2026-10-31')).toMatchObject({ ok: false, code: 'bad_pin' });
    expect(h.run('phoneOlderLogs', PIN, 'yesterday')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(h.run('phoneOlderLogs', PIN, '2026-10-31')).toMatchObject({ ok: true, logs: [], more: false });
  });
});

describe('script v3: locking', () => {
  it('every state-changing path takes the script lock and releases it', () => {
    const h = createScriptHarness();
    let before = h.lockCalls;
    const token = withPin(h);
    const step = (f: () => unknown) => {
      before = h.lockCalls;
      f();
      expect(h.lockCalls).toBeGreaterThan(before);
      expect(h.lockHeld).toBe(false);
    };
    expect(h.lockCalls).toBeGreaterThan(before);
    step(() => h.call('pushState', { token, ...snapshot() }));
    step(() => h.run('phoneAddTask', PIN, { title: 'A', projectId: 'p1', day: 'today' }));
    step(() => h.call('ackInbox', { token, ids: ['x'] }));
    step(() => h.run('phoneData', '0000'));
    step(() => h.call('resetAccess', { pin: PIN, newPin: '1111' }));
    step(() => h.call('setPin', { pin: '2222', oldPin: '1111' }));
  });

  it('releases the lock when the body throws', () => {
    const h = createScriptHarness();
    expect(() => h.run('withLock', () => { throw new Error('boom'); })).toThrow('boom');
    expect(h.lockCalls).toBe(1);
    expect(h.lockHeld).toBe(false);
  });

  it('a push that fails half way returns an error and leaves the lock free', () => {
    const h = createScriptHarness();
    const token = withPin(h);
    Object.defineProperty(h.sheets, 'WorkPulse_Days', {
      enumerable: true,
      get() {
        throw new Error('Service Spreadsheets failed');
      },
    });
    const r = h.call('pushState', { token, ...snapshot() });
    expect(r.status).toBe('error');
    expect(r.message).not.toContain('Service Spreadsheets');
    expect(r.detail).toContain('Service Spreadsheets failed');
    expect(h.props.meta).toBeUndefined();
    expect(h.lockHeld).toBe(false);
  });
});

describe('script v3: exposure and style', () => {
  it('only the intended functions are callable from google.script.run (helpers end with _)', () => {
    const names = [...GOOGLE_APPS_SCRIPT_CODE.matchAll(/^function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
    const exposed = names.filter((n) => !n.endsWith('_')).sort();
    expect(exposed).toEqual([
      'authorizeWorkPulse', 'buildEveningEmail', 'checkPin', 'checkToken', 'doGet', 'doPost', 'getOrCreateLogsSheet', 'hashSecret',
      'phoneAddLog', 'phoneAddTask', 'phoneData', 'phoneOlderLogs', 'sendEveningEmail', 'servePhonePage', 'upsertRows', 'withLock',
    ]);
  });

  it('the script is plain ES5 style: no let/const, arrow functions or template literals', () => {
    expect(GOOGLE_APPS_SCRIPT_CODE).not.toMatch(/\b(let|const)\s/);
    expect(GOOGLE_APPS_SCRIPT_CODE).not.toMatch(/=>/);
    expect(GOOGLE_APPS_SCRIPT_CODE).not.toContain('`');
  });
});
