import { describe, it, expect, beforeAll } from 'vitest';
import { createScriptHarness, type ScriptHarness } from '../../test/appsScriptHarness';
import { GEMINI_MODEL_CASCADE } from '../geminiModels';

// Version 8: with "when I clock out" the Sheet sends each closed day (and a Thursday's week) by itself, from a timer every
// 15 minutes, so a PC shut down at once still gets its email. A Gemini problem only means plain wording.

beforeAll(() => {
  process.env.TZ = 'Asia/Dhaka';
});

const DHAKA = 'Asia/Dhaka';
const KEY = 'AIzaTestKey_1234567890';

function setup(now: string): { h: ScriptHarness; token: string } {
  const h = createScriptHarness({ now: new Date(now) });
  const r = h.call('setPin', { pin: '1234' });
  expect(r.status).toBe('ok');
  return { h, token: r.token as string };
}

const clockoutMode = (h: ScriptHarness, token: string, extra: Record<string, unknown> = {}) =>
  expect(h.call('setEmail', { token, enabled: true, when: 'clockout', hour: 18, minute: 0, tz: DHAKA, ...extra }).status).toBe('ok');

const log = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, date, time: '10:00', project: 'hims', projectId: 'p1', description: `Work ${id}`, status: 'completed', minutes: 30, ...over,
});

function push(h: ScriptHarness, token: string, today: string, workdays: Record<string, unknown>, logs: unknown[]) {
  const r = h.call('pushState', {
    token, today, workdays, logs, tasks: [], projects: [{ id: 'p1', name: 'hims', color: '#0a0' }], workdayHours: 8, tz: DHAKA, deviceId: 'd',
  });
  expect(r.status).toBe('ok');
}

// Wednesday 18 Nov 2026 in Dhaka (UTC+6): in 09:00, out 16:19.
const WED = { '2026-11-18': { clockIn: '2026-11-18T03:00:00.000Z', clockOut: '2026-11-18T10:19:00.000Z' } };

const geminiOk = (text: string) => () => ({ code: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) });

describe('script v8: setEmail', () => {
  it('"when I clock out" sets one timer every 15 minutes and no daily one; the fixed time sets the daily one', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token);
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({ fn: 'sendEveningEmail', everyMinutes: 15 });
    expect(h.triggers[0].hour).toBeUndefined();
    expect(JSON.parse(h.props.email)).toMatchObject({ enabled: true, when: 'clockout', since: '2026-11-18' });

    expect(h.call('setEmail', { token, enabled: true, when: 'fixed', hour: 18, minute: 0, tz: DHAKA }).when).toBe('fixed');
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({ hour: 18, minute: 0 });
    expect(h.triggers[0].everyMinutes).toBeUndefined();
  });

  it('an older desktop (no when) still gets the daily timer', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    expect(h.call('setEmail', { token, enabled: true, hour: 18, minute: 0, tz: DHAKA })).toMatchObject({ status: 'ok', when: 'fixed' });
    expect(h.triggers[0]).toMatchObject({ hour: 18 });
  });

  it('keeps the Gemini key in the Script Properties and never sends it back', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    const r = h.call('setEmail', { token, enabled: true, when: 'clockout', tz: DHAKA, geminiKey: KEY });
    expect(r.geminiKey).toBe(true);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(h.props.geminiKey).toBe(KEY);
    expect(h.call('setEmail', { token, enabled: true, when: 'clockout', tz: DHAKA }).geminiKey).toBe(true); // absent = kept
    expect(h.call('setEmail', { token, enabled: true, when: 'clockout', tz: DHAKA, geminiKey: '' }).geminiKey).toBe(false);
    expect(h.props.geminiKey).toBeUndefined();
  });

  it('takes the newer dotted Gemini keys, and a bad key never blocks the timer (version 11)', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    const dotted = 'AQ.Ab8RN6' + 'x'.repeat(44);
    expect(h.call('setEmail', { token, enabled: true, when: 'clockout', tz: DHAKA, geminiKey: dotted })).toMatchObject({ status: 'ok', geminiKey: true, geminiKeyRejected: false });
    expect(h.props.geminiKey).toBe(dotted);
    const r = h.call('setEmail', { token, enabled: true, when: 'clockout', tz: DHAKA, geminiKey: 'bad key!' });
    expect(r).toMatchObject({ status: 'ok', when: 'clockout', geminiKeyRejected: true, geminiKey: true });
    expect(h.props.geminiKey).toBe(dotted); // the saved key stays
    expect(h.triggers).toHaveLength(1);
  });

  it('switching on again keeps the first day, so no old day is mailed', () => {
    const { h, token } = setup('2026-11-16T03:00:00Z');
    clockoutMode(h, token);
    h.setNow(new Date('2026-11-18T03:00:00Z'));
    clockoutMode(h, token);
    expect(JSON.parse(h.props.email).since).toBe('2026-11-16');
  });
});

describe('script v8: the Sheet sends closed days itself', () => {
  it('waits 10 minutes after the clock-out for the PC, then sends plain wording once', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token);
    push(h, token, '2026-11-18', WED, [log('a', '2026-11-18'), log('b', '2026-11-18', { status: 'in_progress' })]);

    h.setNow(new Date('2026-11-18T10:24:00Z'));
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(0);

    h.setNow(new Date('2026-11-18T10:30:00Z'));
    expect(h.run('sendEveningEmail')).toEqual({ sent: true });
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].subject).toContain('Wed 18 Nov');
    expect(h.mails[0].htmlBody).toContain('What I completed today</div>');
    expect(h.mails[0].htmlBody).toContain('Work a');
    expect(h.mails[0].body).toMatch(/IN PROGRESS[^]*Work b/);
    expect(h.mails[0].body).not.toContain('No data from your PC today');
    const row = h.sheets.WorkPulse_Standups.find((r) => r[0] === 'day:2026-11-18');
    expect(row?.[5]).toBe('template');

    h.setNow(new Date('2026-11-18T10:45:00Z'));
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(1);
    // The PC catching up later does not send it again.
    expect(h.call('sendDayEmail', { token, kind: 'day', date: '2026-11-18' })).toMatchObject({ state: 'sent', duplicate: true });
    expect(h.mails).toHaveLength(1);
  });

  it("sends the PC's standup at once when it is there, without calling Gemini", () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token, { geminiKey: KEY });
    h.setFetch(geminiOk('*What I completed today:*\n- *hims:* Gemini text'));
    push(h, token, '2026-11-18', WED, [log('a', '2026-11-18')]);
    h.call('saveHistory', {
      token, standups: [{ id: 'day:2026-11-18', kind: 'day', from: '2026-11-18', to: '2026-11-18', text: '*What I completed today:*\n- *hims:* PC text', writer: 'claude', createdAt: '2026-11-18T10:20:00.000Z' }],
    });
    h.setNow(new Date('2026-11-18T10:21:00Z'));
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].htmlBody).toContain('PC text');
    expect(h.fetches).toHaveLength(0);
  });

  it('writes the standup with Gemini when the key works; the key goes in a header, not the address', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token, { geminiKey: KEY });
    h.setFetch(geminiOk('```\n*What I completed today:*\n- *hims:* Gemini text\n```'));
    push(h, token, '2026-11-18', WED, [log('a', '2026-11-18')]);
    h.setNow(new Date('2026-11-18T10:30:00Z'));
    h.run('sendEveningEmail');
    expect(h.mails[0].htmlBody).toContain('Gemini text');
    expect(h.mails[0].htmlBody).not.toContain('```');
    expect(h.fetches[0].headers['x-goog-api-key']).toBe(KEY);
    expect(h.fetches[0].url).not.toContain(KEY);
    expect(h.sheets.WorkPulse_Standups.find((r) => r[0] === 'day:2026-11-18')?.[5]).toBe('gemini');
  });

  it('a rate limit on every model, a refused key, or no permission still sends plain wording at once', () => {
    const cases: [string, ((h: ScriptHarness) => void), number][] = [
      ['rate limit', (h) => h.setFetch(() => ({ code: 429, body: '{"error":{"code":429}}' })), GEMINI_MODEL_CASCADE.length],
      ['server error', (h) => h.setFetch(() => ({ code: 503, body: '' })), GEMINI_MODEL_CASCADE.length],
      ['refused key', (h) => h.setFetch(() => ({ code: 403, body: '' })), 1],
      ['bad answer', (h) => h.setFetch(() => ({ code: 200, body: 'not json' })), GEMINI_MODEL_CASCADE.length],
      ['network', (h) => h.setFetch(() => { throw new Error('Address unavailable'); }), 1],
      ['no permission', (h) => h.setFetch(null), 1],
    ];
    for (const [name, arrange, calls] of cases) {
      const { h, token } = setup('2026-11-18T03:00:00Z');
      clockoutMode(h, token, { geminiKey: KEY });
      arrange(h);
      push(h, token, '2026-11-18', WED, [log('a', '2026-11-18')]);
      h.setNow(new Date('2026-11-18T10:30:00Z'));
      h.run('sendEveningEmail');
      expect(h.mails, name).toHaveLength(1);
      expect(h.mails[0].htmlBody, name).toContain('Work a');
      expect(h.fetches, name).toHaveLength(calls);
    }
  });

  it('a forgotten clock-out goes after midnight, not before', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token);
    push(h, token, '2026-11-18', { '2026-11-18': { clockIn: '2026-11-18T03:00:00.000Z' } }, [log('a', '2026-11-18')]);
    h.setNow(new Date('2026-11-18T17:30:00Z')); // 23:30 in Dhaka
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(0);
    h.setNow(new Date('2026-11-18T18:15:00Z')); // 00:15 the next day
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].subject).toContain('Wed 18 Nov');
  });

  it('a day with no log and no standup sends nothing; days before switching on are never sent', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token);
    push(h, token, '2026-11-18', {
      ...WED,
      '2026-11-17': { clockIn: '2026-11-17T03:00:00.000Z', clockOut: '2026-11-17T10:00:00.000Z' },
    }, [log('old', '2026-11-17')]);
    h.setNow(new Date('2026-11-18T10:30:00Z'));
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(0);
  });

  it('a Thursday also sends the week, Friday to Thursday, in plain wording when needed', () => {
    const { h, token } = setup('2026-11-13T03:00:00Z');
    clockoutMode(h, token);
    h.setNow(new Date('2026-11-19T03:00:00Z'));
    push(h, token, '2026-11-19', {
      '2026-11-19': { clockIn: '2026-11-19T02:40:00.000Z', clockOut: '2026-11-19T10:19:00.000Z' },
    }, [log('mon', '2026-11-16'), log('thu', '2026-11-19')]);
    h.setNow(new Date('2026-11-19T10:30:00Z'));
    h.run('sendEveningEmail');
    const week = h.mails.find((m) => m.subject.includes('week standup'));
    expect(h.mails).toHaveLength(2);
    expect(week?.subject).toContain('13 Nov to 19 Nov');
    expect(week?.htmlBody).toContain('What I completed this week</div>');
    expect(week?.htmlBody).toContain('Work mon');
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(2);
  });

  it('a failed send is tried again by the next runs, three tries at most', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token);
    push(h, token, '2026-11-18', WED, [log('a', '2026-11-18')]);
    h.failMail('Gmail is down');
    for (let i = 0; i < 5; i++) {
      h.setNow(new Date(Date.parse('2026-11-18T10:30:00Z') + i * 15 * 60000));
      h.run('sendEveningEmail');
    }
    expect(JSON.parse(h.props.emailLog)[0]).toMatchObject({ s: 'f', n: 3 });
    h.failMail(null);
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(0);
  });

  it('the fixed-time email is not sent in "when I clock out" mode', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token);
    push(h, token, '2026-11-18', { '2026-11-18': { clockIn: '2026-11-18T03:00:00.000Z' } }, [log('a', '2026-11-18')]);
    h.setNow(new Date('2026-11-18T12:00:00Z')); // 18:00 in Dhaka, the saved hour
    expect(h.run('sendEveningEmail')).toEqual({ sent: false });
    expect(h.mails).toHaveLength(0);
  });
});

describe('script v8: the Sheet writes the standup from logs and done tasks together', () => {
  it('lists a done task no log names, and a log with its sub-tasks as sub-points', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token);
    h.call('pushState', {
      token, today: '2026-11-18', workdays: WED, tz: DHAKA, deviceId: 'd', workdayHours: 8, projects: [{ id: 'p1', name: 'hims', color: '#0a0' }],
      logs: [log('a', '2026-11-18', { description: 'Made HMIS stateless', subTasks: ['Shared rate limits', 'One delivery per complaint'] })],
      tasks: [
        { id: 't1', title: 'Fix the voucher bug', project: 'hims', projectId: 'p1', dueDate: '2026-11-18', stage: 'done', trackedMinutes: 40, completedAt: '2026-11-18T08:00:00.000Z' },
        { id: 't2', title: 'made hmis stateless', project: 'hims', projectId: 'p1', dueDate: '2026-11-18', stage: 'done', trackedMinutes: 5, completedAt: '2026-11-18T08:00:00.000Z' },
      ],
    });
    h.setNow(new Date('2026-11-18T10:30:00Z'));
    h.run('sendEveningEmail');
    const text = h.sheets.WorkPulse_Standups.find((r) => r[0] === 'day:2026-11-18')?.[4] as string;
    expect(text).toContain('- *hims:* Made HMIS stateless\n  - Shared rate limits\n  - One delivery per complaint');
    expect(text).toContain('- *hims:* Fix the voucher bug');
    expect(text.match(/stateless/gi)).toHaveLength(1);
    expect(h.mails[0].htmlBody).toMatch(/Made HMIS stateless[^]*>&ndash;<\/td><td[^>]*>Shared rate limits</);
  });
});

describe('script v8: no second list of done tasks under a standup', () => {
  it('the clock-out email with a standup has no "Done today" list; the summary row still counts them', () => {
    const { h, token } = setup('2026-11-18T03:00:00Z');
    clockoutMode(h, token);
    h.call('pushState', {
      token, today: '2026-11-18', workdays: WED, tz: DHAKA, deviceId: 'd', workdayHours: 8, projects: [{ id: 'p1', name: 'hims', color: '#0a0' }],
      logs: [log('a', '2026-11-18')],
      tasks: [{ id: 't1', title: 'Fix the voucher bug', project: 'hims', projectId: 'p1', dueDate: '2026-11-18', stage: 'done', trackedMinutes: 40, completedAt: '2026-11-18T08:00:00.000Z' }],
    });
    h.setNow(new Date('2026-11-18T10:30:00Z'));
    h.run('sendEveningEmail');
    const html = h.mails[0].htmlBody;
    expect(html).toContain('>Standup<');
    expect(html).not.toContain('>Done today<');
    expect(html).toContain('task done');
  });
});
