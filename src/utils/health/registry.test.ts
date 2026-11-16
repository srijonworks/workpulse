import { describe, expect, it, vi } from 'vitest';
import { createHealthRegistry, severityOf, type HealthEntry } from './registry';

const MIN = 60_000;
const HOUR = 60 * MIN;

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('severityOf', () => {
  const failing = (id: string, since: number, count = 1): HealthEntry => ({ id, failingSince: since, count });
  it('is ok when nothing is failing', () => {
    expect(severityOf({ id: 'sheetSync', count: 0 }, 1e9)).toBe('ok');
  });
  it('keeps a failure quiet until its subsystem threshold, because most heal by themselves', () => {
    expect(severityOf(failing('phone', 0), 59 * MIN)).toBe('ok');
    expect(severityOf(failing('phone', 0), 1 * HOUR)).toBe('warning');
    expect(severityOf(failing('unknownThing', 0), 9 * MIN)).toBe('ok');
    expect(severityOf(failing('unknownThing', 0), 10 * MIN)).toBe('warning');
  });
  it('needs a few failures in a row where the table says so', () => {
    expect(severityOf(failing('sheetSync', 0, 2), 3 * HOUR)).toBe('ok');
    expect(severityOf(failing('sheetSync', 0, 3), 3 * HOUR)).toBe('warning');
    expect(severityOf(failing('server', 0, 1), 0)).toBe('ok');
    expect(severityOf(failing('server', 0, 2), 0)).toBe('warning');
  });
  it('turns critical after a long time, and for saving after two minutes', () => {
    expect(severityOf(failing('sheetSync', 0, 9), 23 * HOUR)).toBe('warning');
    expect(severityOf(failing('sheetSync', 0, 9), 24 * HOUR)).toBe('critical');
    expect(severityOf(failing('storage', 0), 119_000)).toBe('warning');
    expect(severityOf(failing('storage', 0), 2 * MIN)).toBe('critical');
  });
});

describe('the registry', () => {
  it('records a failure with its since time, and a success clears it and keeps when it last worked', () => {
    const c = clock();
    const h = createHealthRegistry({ now: c.now });
    h.reportOk('sheetSync');
    c.advance(5 * MIN);
    h.reportFail('sheetSync', { message: 'No connection.', retryable: true });
    expect(h.get('sheetSync')).toMatchObject({ failingSince: 1_000_000 + 5 * MIN, count: 1, message: 'No connection.', retryable: true });
    c.advance(10 * MIN);
    h.reportOk('sheetSync');
    expect(h.get('sheetSync')).toEqual({ id: 'sheetSync', count: 0, lastOkAt: 1_000_000 + 15 * MIN });
  });

  it('counts the same failure again, and starts the count over (but keeps the since time) when the failure changes', () => {
    const c = clock();
    const h = createHealthRegistry({ now: c.now });
    h.reportFail('phone', { message: 'No connection.' });
    c.advance(MIN);
    h.reportFail('phone', { message: 'No connection.' });
    expect(h.get('phone')?.count).toBe(2);
    c.advance(MIN);
    h.reportFail('phone', { message: 'The PIN is wrong.' });
    expect(h.get('phone')).toMatchObject({ count: 1, failingSince: 1_000_000, message: 'The PIN is wrong.' });
  });

  it('lists what needs attention, critical first', () => {
    const c = clock();
    const h = createHealthRegistry({ now: c.now });
    h.reportFail('phone', { message: 'a' });
    h.reportFail('storage', { message: 'b' });
    h.reportFail('activity', { message: 'c' });
    c.advance(3 * MIN);
    const attention = h.attention().map((a) => `${a.entry.id}:${a.severity}`);
    expect(attention).toEqual(['storage:critical', 'activity:warning']); // phone is still inside its hour
  });

  it('gives the same list object until something changes, and tells listeners when it does', () => {
    const h = createHealthRegistry({ now: clock().now });
    const seen = vi.fn();
    h.subscribe(seen);
    const before = h.entries();
    expect(h.entries()).toBe(before);
    h.reportFail('app', { message: 'x' });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(h.entries()).not.toBe(before);
  });

  it('does not make noise for a success that changes nothing', () => {
    const c = clock();
    const h = createHealthRegistry({ now: c.now });
    h.reportOk('server');
    const seen = vi.fn();
    h.subscribe(seen);
    h.reportOk('server');
    expect(seen).not.toHaveBeenCalled();
    c.advance(5000);
    h.reportOk('server');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('keeps only the timeline across a reload, never the text', () => {
    const c = clock();
    const h = createHealthRegistry({ now: c.now });
    h.reportOk('sheetSync');
    h.reportFail('phone', { message: 'secret person text', detail: 'C:\\Users\\DELL\\x' });
    const saved = h.serialize();
    expect(saved).not.toMatch(/secret person text|DELL/);
    const h2 = createHealthRegistry({ now: c.now });
    h2.restore(saved);
    expect(h2.get('sheetSync')?.lastOkAt).toBe(1_000_000);
    expect(h2.get('phone')?.failingSince).toBeUndefined();
  });

  it('ignores damaged saved data', () => {
    const h = createHealthRegistry({ now: clock().now });
    h.restore('{nope');
    h.restore(JSON.stringify({ not: 'an array' }));
    h.restore(JSON.stringify([null, 5, { id: 7 }]));
    h.restore(null);
    expect(h.entries()).toEqual([]);
  });
});
