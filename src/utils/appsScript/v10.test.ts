import { describe, it, expect, beforeAll } from 'vitest';
import { createScriptHarness, type ScriptHarness } from '../../test/appsScriptHarness';

// Version 10: the phone page can clock out the open day. The Sheet closes the day at once (so the email goes even with the
// PC off), keeps the clock-out until the PC takes it, and the first clock-out wins.

beforeAll(() => {
  process.env.TZ = 'Asia/Dhaka';
});

const DHAKA = 'Asia/Dhaka';
const PIN = '1234';
const IN = '2026-11-18T03:00:00.000Z'; // 09:00 in Dhaka

function setup(now: string): { h: ScriptHarness; token: string } {
  const h = createScriptHarness({ now: new Date(now) });
  const r = h.call('setPin', { pin: PIN });
  expect(r.status).toBe('ok');
  return { h, token: r.token as string };
}

function push(h: ScriptHarness, token: string, workdays: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const r = h.call('pushState', {
    token, today: '2026-11-18', workdays, tasks: [], projects: [{ id: 'p1', name: 'hims', color: '#0a0' }], workdayHours: 8, tz: DHAKA, deviceId: 'd',
    logs: [{ id: 'l1', date: '2026-11-18', time: '10:00', project: 'hims', projectId: 'p1', description: 'Work', status: 'completed', minutes: 30 }],
    ...over,
  });
  expect(r.status).toBe('ok');
}

const OPEN = { '2026-11-18': { clockIn: IN } };
const dayRow = (h: ScriptHarness) => h.sheets.WorkPulse_Days.find((r) => r[0] === '2026-11-18');

describe('script v10: clock out from the phone', () => {
  it('closes the open day now, keeps it for the PC, and a retry with the same id changes nothing', () => {
    const { h, token } = setup('2026-11-18T11:00:00Z');
    push(h, token, OPEN);
    const r = h.run('phoneClockOut', PIN, { id: 'po-abc12345' });
    expect(r).toMatchObject({ ok: true, clockOut: { id: 'po-abc12345', date: '2026-11-18', clockOut: '2026-11-18T11:00:00.000Z', taken: false } });
    expect(dayRow(h)?.[2]).toBe('2026-11-18T11:00:00.000Z');

    h.setNow(new Date('2026-11-18T11:05:00Z'));
    expect(h.run('phoneClockOut', PIN, { id: 'po-abc12345' }).clockOut.clockOut).toBe('2026-11-18T11:00:00.000Z');
    expect(h.call('pullInbox', { token }).clockOuts).toEqual([
      { id: 'po-abc12345', date: '2026-11-18', clockIn: IN, clockOut: '2026-11-18T11:00:00.000Z' },
    ]);
  });

  it('takes a past time after the clock-in, and refuses one before it or still to come', () => {
    const { h, token } = setup('2026-11-18T13:00:00Z');
    push(h, token, OPEN);
    expect(h.run('phoneClockOut', PIN, { id: 'po-early0001', at: '2026-11-18T02:00:00.000Z' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(h.run('phoneClockOut', PIN, { id: 'po-future001', at: '2026-11-18T14:00:00.000Z' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(h.run('phoneClockOut', PIN, { id: 'po-past00001', at: '2026-11-18T11:30:00.000Z' }).clockOut.clockOut).toBe('2026-11-18T11:30:00.000Z');
  });

  it('needs the PIN, an open day and the switch on', () => {
    const { h, token } = setup('2026-11-18T11:00:00Z');
    push(h, token, OPEN);
    expect(h.run('phoneClockOut', '9999', { id: 'po-abc12345' }).code).toBe('bad_pin');
    expect(dayRow(h)?.[2]).toBe('');

    push(h, token, OPEN, { phoneClockOut: false });
    expect(h.run('phoneData', PIN).clockOutEnabled).toBe(false);
    expect(h.run('phoneClockOut', PIN, { id: 'po-abc12345' }).code).toBe('off');

    push(h, token, { '2026-11-18': { clockIn: IN, clockOut: '2026-11-18T10:00:00.000Z' } });
    expect(h.run('phoneData', PIN).clockOutEnabled).toBe(true);
    expect(h.run('phoneClockOut', PIN, { id: 'po-abc12345' }).code).toBe('not_open');
    expect(dayRow(h)?.[2]).toBe('2026-11-18T10:00:00.000Z');
  });

  it('closes yesterday when today has no clock-in (working past midnight)', () => {
    const { h, token } = setup('2026-11-18T19:30:00Z'); // 01:30 on the 19th in Dhaka
    push(h, token, OPEN, { today: '2026-11-19' });
    expect(h.run('phoneClockOut', PIN, { id: 'po-late0001' }).clockOut).toMatchObject({ date: '2026-11-18', clockOut: '2026-11-18T19:30:00.000Z' });
  });

  it('a push of the still open day keeps the waiting clock-out; once taken, the PC copy rules (Resume)', () => {
    const { h, token } = setup('2026-11-18T11:00:00Z');
    push(h, token, OPEN);
    h.run('phoneClockOut', PIN, { id: 'po-abc12345' });

    push(h, token, OPEN); // the PC has not pulled yet
    expect(dayRow(h)?.[2]).toBe('2026-11-18T11:00:00.000Z');

    expect(h.call('ackInbox', { token, ids: [], clockOutIds: ['po-abc12345'] })).toMatchObject({ status: 'ok', clockOuts: 1 });
    expect(h.call('pullInbox', { token }).clockOuts).toEqual([]);
    expect(h.run('phoneData', PIN).clockOuts[0]).toMatchObject({ id: 'po-abc12345', taken: true, undoUntil: '' });

    push(h, token, OPEN); // Resume on the PC
    expect(dayRow(h)?.[2]).toBe('');
  });

  it('a push from a PC that clocked out on its own keeps the PC time (first clock-out wins)', () => {
    const { h, token } = setup('2026-11-18T11:00:00Z');
    push(h, token, OPEN);
    h.run('phoneClockOut', PIN, { id: 'po-abc12345' });
    push(h, token, { '2026-11-18': { clockIn: IN, clockOut: '2026-11-18T10:45:00.000Z' } });
    expect(dayRow(h)?.[2]).toBe('2026-11-18T10:45:00.000Z');
  });

  it('Undo reopens the day within 10 minutes and before the PC takes it', () => {
    const { h, token } = setup('2026-11-18T11:00:00Z');
    push(h, token, OPEN);
    h.run('phoneClockOut', PIN, { id: 'po-abc12345' });
    h.setNow(new Date('2026-11-18T11:09:00Z'));
    expect(h.run('phoneUndoClockOut', PIN, 'po-abc12345')).toEqual({ ok: true });
    expect(dayRow(h)?.[2]).toBe('');
    expect(h.call('pullInbox', { token }).clockOuts).toEqual([]);

    h.run('phoneClockOut', PIN, { id: 'po-second01' });
    h.setNow(new Date('2026-11-18T11:20:00Z'));
    expect(h.run('phoneUndoClockOut', PIN, 'po-second01').code).toBe('too_late');

    const { h: h2, token: t2 } = setup('2026-11-18T11:00:00Z');
    push(h2, t2, OPEN);
    h2.run('phoneClockOut', PIN, { id: 'po-abc12345' });
    h2.call('ackInbox', { token: t2, ids: [], clockOutIds: ['po-abc12345'] });
    expect(h2.run('phoneUndoClockOut', PIN, 'po-abc12345').code).toBe('taken');
    expect(h2.run('phoneUndoClockOut', '0000', 'po-abc12345').code).toBe('bad_pin');
  });

  it('the email waits for the PC up to 60 minutes, then sends; once the PC takes it, the usual 10 minutes from then', () => {
    const { h, token } = setup('2026-11-18T11:00:00Z');
    expect(h.call('setEmail', { token, enabled: true, when: 'clockout', hour: 18, minute: 0, tz: DHAKA }).status).toBe('ok');
    push(h, token, OPEN);
    h.run('phoneClockOut', PIN, { id: 'po-abc12345' });

    h.setNow(new Date('2026-11-18T11:30:00Z'));
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(0);

    h.setNow(new Date('2026-11-18T12:01:00Z'));
    h.run('sendEveningEmail');
    expect(h.mails).toHaveLength(1);

    const { h: h2, token: t2 } = setup('2026-11-18T11:00:00Z');
    expect(h2.call('setEmail', { token: t2, enabled: true, when: 'clockout', hour: 18, minute: 0, tz: DHAKA }).status).toBe('ok');
    push(h2, t2, OPEN);
    h2.run('phoneClockOut', PIN, { id: 'po-abc12345' });
    h2.setNow(new Date('2026-11-18T11:20:00Z'));
    h2.call('ackInbox', { token: t2, ids: [], clockOutIds: ['po-abc12345'] });
    h2.setNow(new Date('2026-11-18T11:25:00Z'));
    h2.run('sendEveningEmail');
    expect(h2.mails).toHaveLength(0);
    h2.setNow(new Date('2026-11-18T11:31:00Z'));
    h2.run('sendEveningEmail');
    expect(h2.mails).toHaveLength(1);
  });

  it('an older desktop (no clockOutIds) still acks tasks, and the waiting clock-out stays', () => {
    const { h, token } = setup('2026-11-18T11:00:00Z');
    push(h, token, OPEN);
    h.run('phoneClockOut', PIN, { id: 'po-abc12345' });
    expect(h.call('ackInbox', { token, ids: [] })).toMatchObject({ status: 'ok', clockOuts: 0 });
    expect(h.call('pullInbox', { token }).clockOuts).toHaveLength(1);
    expect(h.call('ackInbox', { token, ids: [], clockOutIds: 'x' }).code).toBe('bad_request');
  });
});
