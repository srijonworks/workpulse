import { describe, it, expect, beforeAll } from 'vitest';
import { createScriptHarness, zonedTime, type ScriptHarness } from '../../test/appsScriptHarness';
import { GOOGLE_APPS_SCRIPT_CODE } from '../googleAppsScriptTemplate';

beforeAll(() => {
  process.env.TZ = 'Asia/Dhaka';
});

const DHAKA = 'Asia/Dhaka';
const at = (day: number, h: number, m = 0) => zonedTime(DHAKA, 2026, 11, day, h, m);

const log = (id: string, project: string, projectId: string, description: string, minutes: number, time = '10:00', date = '2026-11-10') => ({
  id, date, time, project, projectId, description, status: 'completed', minutes,
});

// Tue 10 Nov: 5 logs, 484 minutes, in 09:48, out 17:52 (the mockup's day).
const MOCKUP_LOGS = [
  log('l1', 'BGB Portal', 'p1', 'Built attendance report filters and fixed the timezone bug', 130, '10:00'),
  log('l2', 'BGB Portal', 'p1', 'Reviewed search PR #212, requested index change', 94, '12:30'),
  log('l3', 'HR Dashboard', 'p2', 'Wrote leave balance migration', 148, '13:00'),
  log('l4', 'HR Dashboard', 'p2', 'Leave balance: schema review with Rafiq', 52, '15:30'),
  log('l5', 'Meetings', 'p3', 'Monthly progress meeting with section head', 60, '16:30'),
];
const PROJECTS = [
  { id: 'p1', name: 'BGB Portal', color: '#2e86de' },
  { id: 'p2', name: 'HR Dashboard', color: '#e07a2f' },
  { id: 'p3', name: 'Meetings', color: '#8e5bd6' },
];
const WORKDAY_10 = { clockIn: at(10, 9, 48).toISOString(), clockOut: at(10, 17, 52).toISOString() };

function state(over: Record<string, unknown> = {}) {
  return {
    tasks: [
      { id: 't1', title: 'Deploy suggestions build', projectId: 'p1', project: 'BGB Portal', dueDate: '2026-11-10', stage: 'done', trackedMinutes: 30, completedAt: at(10, 15).toISOString(), fromPhone: false },
      { id: 't2', title: 'Send attendance report', projectId: 'p1', project: 'BGB Portal', dueDate: '2026-11-10', stage: 'planned', trackedMinutes: 0, fromPhone: false },
      { id: 't3', title: 'Draft RFC for search indexing', projectId: 'p2', project: 'HR Dashboard', dueDate: '2026-11-09', stage: 'planned', trackedMinutes: 0, fromPhone: false },
      { id: 't4', title: 'Review leave form API', projectId: 'p2', project: 'HR Dashboard', dueDate: '2026-11-08', stage: 'blocked', trackedMinutes: 0, fromPhone: false },
      { id: 't5', title: 'Finished long ago', projectId: 'p2', project: 'HR Dashboard', dueDate: '2026-11-05', stage: 'done', trackedMinutes: 5, completedAt: at(5, 15).toISOString(), fromPhone: false },
    ],
    logs: MOCKUP_LOGS,
    workdays: { '2026-11-10': WORKDAY_10 },
    projects: PROJECTS,
    workdayHours: 8,
    tz: DHAKA,
    deviceId: 'dev-aaa',
    today: '2026-11-10',
    ...over,
  };
}

// A script with a PIN, the email switched on (unless withEmail is false), a push at 17:52 (or pushAt) on
// Tue 10 Nov and the clock at 18:00 the same day.
function evening(over: Record<string, unknown> = {}, withEmail = true, pushAt: Date = at(10, 17, 52)): { h: ScriptHarness; token: string } {
  const h = createScriptHarness({ now: pushAt });
  const token = h.call('setPin', { pin: '1234' }).token as string;
  expect(h.call('pushState', { token, ...state(over) }).status).toBe('ok');
  if (withEmail) expect(h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA }).status).toBe('ok');
  h.setNow(at(10, 18, 0));
  return { h, token };
}

describe('evening email: recipients', () => {
  it('sends to the saved addresses instead of the owner, test email too', () => {
    const { h, token } = evening();
    expect(h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA, to: 'boss@example.com, me@example.org' })).toMatchObject({ status: 'ok', to: 'boss@example.com,me@example.org' });
    h.run('sendEveningEmail');
    expect(h.mails[0].to).toBe('boss@example.com,me@example.org');
    h.call('sendTestEmail', { token });
    expect(h.mails[1].to).toBe('boss@example.com,me@example.org');
  });

  it('refuses a bad address or more than 5, keeps the saved ones when no address is sent, and empty goes back to the owner', () => {
    const { h, token } = evening();
    const cfg = { token, enabled: true, hour: 18, minute: 0, tz: DHAKA };
    expect(h.call('setEmail', { ...cfg, to: 'not an address' })).toMatchObject({ status: 'error', code: 'bad_request' });
    expect(h.call('setEmail', { ...cfg, to: 'a@x.com,b@x.com,c@x.com,d@x.com,e@x.com,f@x.com' })).toMatchObject({ status: 'error' });
    h.call('setEmail', { ...cfg, to: 'a@x.com' });
    expect(h.call('setEmail', cfg)).toMatchObject({ to: 'a@x.com' });
    expect(h.call('setEmail', { ...cfg, to: '' })).toMatchObject({ to: '' });
  });
});

describe('evening email: content', () => {
  it('lists the sub-tasks of each log in the plain-text body only', () => {
    const logs = [{ ...MOCKUP_LOGS[0], subTasks: ['Filter by team', 'Fix <b>timezone</b>'] }, ...MOCKUP_LOGS.slice(1)];
    const { h } = evening({ logs });
    h.run('sendEveningEmail');
    const { htmlBody: html, body: text } = h.mails[0];
    // The HTML stays short: sub-tasks are only in the plain-text body.
    expect(html).not.toContain('Filter by team');
    expect(text).toContain('      - Filter by team');
  });

  it('has the exact subject for 5 logs and 484 minutes', () => {
    const { h } = evening();
    expect(h.run('sendEveningEmail')).toEqual({ sent: true });
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].subject).toBe('WorkPulse · Tue 10 Nov · 8:04 worked · 5 logs');
  });

  it('shows the header, the data line, projects with minutes, done tasks, open tasks and the footer', () => {
    const { h } = evening();
    h.run('sendEveningEmail');
    const { htmlBody: html, body: text } = h.mails[0];
    expect(html).toContain('Tuesday 10 November');
    expect(html).toContain('8:04');
    expect(html).toContain('worked of 8:00');
    expect(html).toMatch(/>In<\/div><div[^>]*>09:48</);
    expect(html).toMatch(/>Out<\/div><div[^>]*>17:52</);
    expect(html).toContain('Data from your PC as of 17:52.');
    for (const p of ['BGB Portal', 'HR Dashboard', 'Meetings']) expect(html).toContain(p);
    expect(html).toContain('3:44');
    expect(html).toContain('3:20');
    expect(html).toContain('>Logs<');
    expect(html).toContain('logged in 5 entries');
    expect(html).toContain('Built attendance report filters and fixed the timezone bug');
    expect(html).not.toContain('>Done today<');
    expect(text).not.toContain('TASKS DONE TODAY');
    expect(html).not.toContain('Finished long ago');
    expect(html).toMatch(/>Still open<\/td><td[^>]*>3</);
    expect(html).toContain('Sent by your WorkPulse script at 18:00 (Asia/Dhaka)');
    expect(html).toContain('#0f3d2e');
    expect(html).toContain('#f2b705');
    expect(html).toContain('#2e86de');
    expect(text).toContain('8:04 worked of 8:00');
    expect(text).toContain('Built attendance report filters and fixed the timezone bug (2:10)');
  });

  it('lists open tasks today first, then earlier days newest first, each with when it was due', () => {
    const { h } = evening();
    h.run('sendEveningEmail');
    const html = h.mails[0].htmlBody;
    const at_ = (s: string) => html.indexOf(s);
    // Each title is followed by its due label, and the rows go Today, Yesterday, Sun 8 Nov.
    expect(at_('Send attendance report')).toBeGreaterThan(-1);
    expect(at_('>Today<')).toBeGreaterThan(at_('Send attendance report'));
    expect(at_('Draft RFC for search indexing')).toBeGreaterThan(at_('>Today<'));
    expect(at_('>Yesterday<')).toBeGreaterThan(at_('Draft RFC for search indexing'));
    expect(at_('Review leave form API')).toBeGreaterThan(at_('>Yesterday<'));
    expect(at_('>Sun 8 Nov<')).toBeGreaterThan(at_('Review leave form API'));
    expect(html).toMatch(/Review leave form API<\/div>[^]*>blocked</);
  });

  it('escapes every user text in the HTML and keeps the plain text free of tags', () => {
    const evil = '<script>alert(1)</script> & "x"';
    const { h } = evening({
      logs: [log('l1', '<b>Proj</b>', 'p9', evil, 60)],
      tasks: [
        { id: 't1', title: '<img src=x onerror=alert(2)>', projectId: '', project: '', dueDate: '2026-11-10', stage: 'planned', trackedMinutes: 0 },
        { id: 't2', title: evil, projectId: '', project: '', dueDate: '2026-11-10', stage: 'done', trackedMinutes: 0, completedAt: at(10, 12).toISOString() },
      ],
    });
    h.run('sendEveningEmail');
    const { htmlBody: html, body: text } = h.mails[0];
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(html).toContain('&lt;b&gt;Proj&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Proj');
    // The only tags in the HTML are the ones the script writes.
    const tags = [...html.matchAll(/<\/?([a-z][a-z0-9]*)/gi)].map((m) => m[1].toLowerCase());
    expect(new Set(tags)).toEqual(new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'table', 'tr', 'td', 'div', 'span']));
    expect(text).not.toMatch(/<[^>]*>/);
    expect(text).toContain('alert(1)');
  });

  it('a project colour that is not a plain hex colour is not put into the style', () => {
    const { h } = evening({ projects: [{ id: 'p1', name: 'BGB Portal', color: 'red;background:url(x)' }] });
    h.run('sendEveningEmail');
    expect(h.mails[0].htmlBody).not.toContain('url(x)');
  });

  it('says there is no data from the PC today when the last push is older than today', () => {
    const h = createScriptHarness({ now: at(9, 17, 52) });
    const token = h.call('setPin', { pin: '1234' }).token as string;
    h.call('pushState', { token, ...state({ today: '2026-11-09' }) });
    h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA });
    h.setNow(at(10, 18, 0));
    h.run('sendEveningEmail');
    const html = h.mails[0].htmlBody;
    expect(html).toContain('No data from your PC today.');
    expect(html).not.toContain('Data from your PC as of');
    expect(h.mails[0].body).toContain('No data from your PC today.');
  });

  it('says "still clocked in" until a clock-out and "not clocked in" without one', () => {
    const open = evening({ workdays: { '2026-11-10': { clockIn: at(10, 9, 48).toISOString() } } });
    open.h.run('sendEveningEmail');
    expect(open.h.mails[0].htmlBody).toContain('still clocked in');
    // The PC last sent at 17:52, so the open-ended time stops there, not at the 18:00 send.
    expect(open.h.mails[0].subject).toContain('8:04 worked');

    const none = evening({ workdays: {} });
    none.h.run('sendEveningEmail');
    expect(none.h.mails[0].htmlBody).toContain('not clocked in');
    expect(none.h.mails[0].subject).toBe('WorkPulse · Tue 10 Nov · 8:04 worked · 5 logs');
  });

  it('does not count time after the last data from the PC while still clocked in', () => {
    const stopped = evening({ workdays: { '2026-11-10': { clockIn: at(10, 9, 48).toISOString() } } }, true, at(10, 14, 0));
    stopped.h.run('sendEveningEmail');
    expect(stopped.h.mails[0].subject).toContain('4:12 worked');
    expect(stopped.h.mails[0].htmlBody).toContain('Data from your PC as of 14:00.');
    expect(stopped.h.mails[0].htmlBody).not.toContain('8:12');
  });

  it('uses the logged time when still clocked in and the PC sent nothing today', () => {
    const { h } = evening({ workdays: { '2026-11-10': { clockIn: at(10, 9, 48).toISOString() } } }, true, at(9, 17, 0));
    h.run('sendEveningEmail');
    expect(h.mails[0].subject).toBe('WorkPulse \u00b7 Tue 10 Nov \u00b7 8:04 worked \u00b7 5 logs');
    expect(h.mails[0].htmlBody).toContain('No data from your PC today.');
  });

  it('warns about phone tasks the PC has not taken yet', () => {
    const { h } = evening();
    expect(h.run('phoneAddTask', '1234', { title: 'Call the bank', projectId: '', day: 'today' }).ok).toBe(true);
    h.run('sendEveningEmail');
    expect(h.mails[0].htmlBody).toContain('1 task added on your phone is not on your PC yet.');
    expect(h.mails[0].body).toContain('1 task added on your phone is not on your PC yet.');
  });

  it('buildEveningEmail is pure: it sends nothing and flags an empty day as skip', () => {
    const h = createScriptHarness({ now: at(11, 12, 0) });
    const base = { date: '2026-11-10', tz: DHAKA, now: at(10, 18, 0).toISOString(), tasks: [], logs: [], workday: null, workdayHours: 8, pushedAt: '', pendingPhoneCount: 0 };
    const empty = h.run('buildEveningEmail', base);
    expect(empty.skip).toBe(true);
    const full = h.run('buildEveningEmail', { ...base, logs: MOCKUP_LOGS });
    expect(full.skip).toBe(false);
    expect(full.subject).toContain('8:04 worked · 5 logs');
    // It uses the moment it is given (18:00 on the 10th), not the script clock (12:00 on the 11th).
    expect(full.html).toContain('Sent by your WorkPulse script at 18:00 (Asia/Dhaka)');
    expect(h.mails).toHaveLength(0);
  });

  it('a day of logs alone shows things done and projects, not "0 tasks done" (version 12)', () => {
    const logs = [{ ...MOCKUP_LOGS[0], subTasks: ['Filter by team', 'Fix timezone', 'Add export'] }, ...MOCKUP_LOGS.slice(1)];
    const { h } = evening({ logs, tasks: [] });
    h.run('sendEveningEmail');
    const { htmlBody: html, body: text } = h.mails[0];
    // 3 sub-tasks on the first log, 1 for each of the other 4 logs; 3 projects.
    expect(html).toMatch(/>7<\/[^>]+>(?:<[^>]+>)*things done</);
    expect(html).toMatch(/>3<\/[^>]+>(?:<[^>]+>)*projects</);
    expect(html).not.toContain('tasks done');
    expect(html).not.toContain('still open');
    expect(html).toContain('7 things done, 3 projects');
    expect(text).not.toContain('STILL OPEN');
  });

  it('a day with tasks keeps the task tiles', () => {
    const { h } = evening();
    h.run('sendEveningEmail');
    const { htmlBody: html, body: text } = h.mails[0];
    expect(html).toContain('task done');
    expect(html).toContain('still open');
    expect(html).not.toContain('things done');
    expect(text).toContain('STILL OPEN');
  });
});

describe('evening email: when it is sent', () => {
  it('sends nothing when the day has no log and no clock-in, and sends when there is only a clock-in', () => {
    const quiet = evening({ logs: [], workdays: {} });
    expect(quiet.h.run('sendEveningEmail')).toEqual({ sent: false });
    expect(quiet.h.mails).toHaveLength(0);
    expect(quiet.h.props.lastEmailDate).toBeUndefined();

    const clockOnly = evening({ logs: [], workdays: { '2026-11-10': { clockIn: at(10, 9, 0).toISOString() } } });
    clockOnly.h.run('sendEveningEmail');
    expect(clockOnly.h.mails).toHaveLength(1);

    const logOnly = evening({ workdays: {} });
    logOnly.h.run('sendEveningEmail');
    expect(logOnly.h.mails).toHaveLength(1);
  });

  it('sends at most once per local date, and again on the next date', () => {
    const { h, token } = evening();
    h.run('sendEveningEmail');
    h.run('sendEveningEmail');
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(1);
    expect(h.props.lastEmailDate).toBe('2026-11-10');

    // The next day, with its own log, is a new date.
    h.setNow(at(11, 17, 50));
    h.call('pushState', {
      token,
      ...state({ today: '2026-11-11', logs: [log('l9', 'Meetings', 'p3', 'Standup', 15, '09:30', '2026-11-11')], workdays: {} }),
    });
    h.setNow(at(11, 18, 0));
    h.run('sendEveningEmail');
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(2);
    expect(h.mails[1].subject).toBe('WorkPulse · Wed 11 Nov · 0:15 worked · 1 log');
    expect(h.props.lastEmailDate).toBe('2026-11-11');
  });

  it('uses the user zone for the date, not the script zone', () => {
    const h = createScriptHarness({ spreadsheetTz: 'America/New_York', now: zonedTime(DHAKA, 2026, 11, 10, 17, 52) });
    const token = h.call('setPin', { pin: '1234' }).token as string;
    h.call('pushState', { token, ...state() });
    h.call('setEmail', { token, enabled: true, hour: 2, minute: 0, tz: DHAKA });
    // 02:00 on Wed 11 Nov in Dhaka is still Tue 10 Nov in New York.
    h.setNow(zonedTime(DHAKA, 2026, 11, 11, 2, 0));
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(0); // the user's date is Wed 11 Nov: no log, no clock-in
    expect(h.props.lastEmailDate).toBeUndefined();

    // With data for the user's date (Wed 11 Nov), the same kind of moment sends, although the Sheet's zone is still on Tue 10 Nov.
    h.setNow(zonedTime(DHAKA, 2026, 11, 11, 1, 0));
    h.call('pushState', {
      token,
      ...state({ today: '2026-11-11', logs: [log('l9', 'Meetings', 'p3', 'Night deploy', 45, '01:00', '2026-11-11')], workdays: {} }),
    });
    h.setNow(zonedTime(DHAKA, 2026, 11, 11, 2, 0));
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].subject).toBe('WorkPulse \u00b7 Wed 11 Nov \u00b7 0:45 worked \u00b7 1 log');
    expect(h.props.lastEmailDate).toBe('2026-11-11');
  });

  it('records the date only after the mail was sent', () => {
    const { h } = evening();
    const realPush = h.mails.push;
    Object.defineProperty(h.mails, 'push', {
      configurable: true,
      value: () => {
        throw new Error('Service invoked too many times for one day: email.');
      },
    });
    expect(() => h.run('sendEveningEmail')).toThrow(/too many times/);
    expect(h.props.lastEmailDate).toBeUndefined();
    expect(h.lockHeld).toBe(false);
    Object.defineProperty(h.mails, 'push', { configurable: true, value: realPush });
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(1);
    expect(h.props.lastEmailDate).toBe('2026-11-10');
  });

  it('only ever mails the effective user', () => {
    const { h } = evening();
    h.run('sendEveningEmail');
    expect(h.mails[0].to).toBe('owner@gmail.com');
    // A google.script.run caller cannot pick the address: the function takes no input and there is one send call.
    expect(GOOGLE_APPS_SCRIPT_CODE).toMatch(/function sendEveningEmail\(\)/);
    expect(GOOGLE_APPS_SCRIPT_CODE.match(/MailApp\.sendEmail/g)).toHaveLength(1);
  });
});

describe('evening email: switched on or off', () => {
  it('sends nothing before setEmail, sends once it is enabled, and nothing again after it is disabled', () => {
    const { h, token } = evening({}, false);
    expect(h.run('sendEveningEmail')).toEqual({ sent: false });
    expect(h.mails).toHaveLength(0);
    expect(h.props.lastEmailDate).toBeUndefined();

    h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA });
    expect(h.run('sendEveningEmail')).toEqual({ sent: true });
    expect(h.mails).toHaveLength(1);

    h.setNow(at(11, 18, 0));
    h.call('pushState', { token, ...state({ today: '2026-11-11', logs: [log('l9', 'Meetings', 'p3', 'Standup', 15, '09:30', '2026-11-11')], workdays: {} }) });
    h.call('setEmail', { token, enabled: false });
    expect(h.run('sendEveningEmail')).toEqual({ sent: false });
    expect(h.mails).toHaveLength(1);
    expect(h.props.lastEmailDate).toBe('2026-11-10');
  });
});

describe('evening email: setEmail and sendTestEmail', () => {
  it('setEmail enabled leaves exactly one trigger, however often it is called', () => {
    const { h, token } = evening();
    const r = h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA });
    expect(r).toMatchObject({ status: 'ok', enabled: true, hour: 18, minute: 0, tz: DHAKA });
    h.call('setEmail', { token, enabled: true, hour: 19, minute: 30, tz: DHAKA });
    expect(h.triggers).toEqual([expect.objectContaining({ fn: 'sendEveningEmail', hour: 19, minute: 30, tz: DHAKA })]);
    expect(JSON.parse(h.props.email)).toEqual({ enabled: true, when: 'fixed', hour: 19, minute: 30, tz: DHAKA });
    expect(h.lockHeld).toBe(false);
  });

  it('a failing trigger create keeps the old trigger and the saved settings', () => {
    const { h, token } = evening({}, false);
    h.breakTriggers(true);
    // First time: nothing was set up, nothing is claimed.
    expect(h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA })).toMatchObject({ status: 'error', code: 'error' });
    expect(h.triggers).toHaveLength(0);
    expect(h.props.email).toBeUndefined();
    expect(h.run('sendEveningEmail')).toEqual({ sent: false });

    // Later: the working 18:00 trigger and its settings survive a failed change to 19:30.
    h.breakTriggers(false);
    h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA });
    h.breakTriggers(true);
    const r = h.call('setEmail', { token, enabled: true, hour: 19, minute: 30, tz: DHAKA });
    expect(r).toMatchObject({ status: 'error', code: 'error' });
    expect(h.triggers).toEqual([expect.objectContaining({ fn: 'sendEveningEmail', hour: 18, minute: 0 })]);
    expect(JSON.parse(h.props.email)).toEqual({ enabled: true, when: 'fixed', hour: 18, minute: 0, tz: DHAKA });
    expect(h.lockHeld).toBe(false);
  });

  it('only touches its own trigger', () => {
    const { h, token } = evening();
    h.triggers.push({ fn: 'somethingElse' });
    h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA });
    h.call('setEmail', { token, enabled: false, hour: 18, minute: 0, tz: DHAKA });
    expect(h.triggers.map((t) => t.fn)).toEqual(['somethingElse']);
  });

  it('enabled:false removes the trigger and remembers it is off', () => {
    const { h, token } = evening();
    h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA });
    expect(h.call('setEmail', { token, enabled: false })).toMatchObject({ status: 'ok', enabled: false });
    expect(h.triggers).toHaveLength(0);
    expect(JSON.parse(h.props.email).enabled).toBe(false);
  });

  it('needs the desktop token and a sensible time and zone', () => {
    const { h, token } = evening({}, false);
    expect(h.call('setEmail', { token: 'nope', enabled: true, hour: 18, minute: 0, tz: DHAKA }).code).toBe('bad_token');
    expect(h.call('sendTestEmail', { token: 'nope' }).code).toBe('bad_token');
    expect(h.call('setEmail', { token: '', enabled: true, hour: 18, minute: 0, tz: DHAKA }).code).toBe('bad_token');
    for (const bad of [{ hour: 24, minute: 0 }, { hour: -1, minute: 0 }, { hour: 18, minute: 60 }, { hour: 18.5, minute: 0 }, { hour: '18', minute: 0 }, { hour: 18 }]) {
      expect(h.call('setEmail', { token, enabled: true, tz: DHAKA, ...bad })).toMatchObject({ status: 'error', code: 'bad_request' });
    }
    expect(h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: 'Mars/Base' })).toMatchObject({ status: 'error', code: 'bad_request', message: 'That time zone is not known.' });
    expect(h.call('setEmail', { token, hour: 18, minute: 0, tz: DHAKA }).code).toBe('bad_request');
    expect(h.triggers).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
  });

  it('sendTestEmail on an empty day sends one email that says there is no data yet', () => {
    const h = createScriptHarness({ now: at(10, 18, 0) });
    const token = h.call('setPin', { pin: '1234' }).token as string;
    expect(h.call('sendTestEmail', { token })).toEqual({ status: 'ok', sent: true, to: 'owner@gmail.com' });
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].to).toBe('owner@gmail.com');
    expect(h.mails[0].subject).toBe('WorkPulse · Tue 10 Nov · no data yet');
    expect(h.mails[0].htmlBody).toContain('No data yet');
    expect(h.mails[0].htmlBody).toContain('This is a test email.');
    expect(h.mails[0].body).toContain('No data yet');
  });

  it('sendTestEmail ignores the once-a-day guard and does not change it', () => {
    const { h, token } = evening();
    h.run('sendEveningEmail');
    expect(h.props.lastEmailDate).toBe('2026-11-10');
    h.call('sendTestEmail', { token });
    h.call('sendTestEmail', { token });
    expect(h.mails).toHaveLength(3);
    expect(h.props.lastEmailDate).toBe('2026-11-10');

    const fresh = evening();
    fresh.h.call('sendTestEmail', { token: fresh.token });
    expect(fresh.h.props.lastEmailDate).toBeUndefined();
    fresh.h.run('sendEveningEmail');
    expect(fresh.h.mails).toHaveLength(2);
  });
});

describe('evening email: send window and allowed times', () => {
  it('called early does nothing and does not burn the day; called near the time sends', () => {
    const { h } = evening();
    h.setNow(at(10, 9, 0));
    expect(h.run('sendEveningEmail')).toEqual({ sent: false });
    expect(h.mails).toHaveLength(0);
    expect(h.props.lastEmailDate).toBeUndefined();

    h.setNow(at(10, 17, 10)); // 50 minutes early
    expect(h.run('sendEveningEmail')).toEqual({ sent: false });
    expect(h.props.lastEmailDate).toBeUndefined();

    h.setNow(at(10, 17, 20)); // 40 minutes early
    expect(h.run('sendEveningEmail')).toEqual({ sent: true });
    expect(h.props.lastEmailDate).toBe('2026-11-10');
  });

  it('a late trigger (20 minutes) still sends, an hour late does not', () => {
    const { h } = evening();
    h.setNow(at(10, 18, 20));
    expect(h.run('sendEveningEmail')).toEqual({ sent: true });

    const late = evening();
    late.h.setNow(at(10, 19, 0));
    expect(late.h.run('sendEveningEmail')).toEqual({ sent: false });
    expect(late.h.props.lastEmailDate).toBeUndefined();
  });

  it('setEmail rejects times outside 00:30-23:29 and accepts the edges', () => {
    const { h, token } = evening({}, false);
    for (const [hour, minute] of [[23, 50], [0, 10], [23, 30], [0, 0], [0, 29]]) {
      const r = h.call('setEmail', { token, enabled: true, hour, minute, tz: DHAKA });
      expect(r).toMatchObject({ status: 'error', code: 'bad_request' });
      expect(String(r.message)).toMatch(/00:30/);
    }
    expect(h.triggers).toHaveLength(0);
    expect(h.call('setEmail', { token, enabled: true, hour: 0, minute: 30, tz: DHAKA }).status).toBe('ok');
    expect(h.call('setEmail', { token, enabled: true, hour: 23, minute: 29, tz: DHAKA }).status).toBe('ok');
    // Switching it off is never refused for its time.
    expect(h.call('setEmail', { token, enabled: false }).status).toBe('ok');
  });
});
