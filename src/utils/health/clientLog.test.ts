import { describe, expect, it, vi } from 'vitest';
import { createClientLogSender, type ClientLogEntry } from './clientLog';

const entry = (n: number): ClientLogEntry => ({ level: 'error', area: 'a', message: `m${n}` });

// A clock that only moves when the test says so.
const manualTimer = () => {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    cancel: (h: unknown) => {
      const i = pending.indexOf(h as (typeof pending)[number]);
      if (i >= 0) pending.splice(i, 1);
    },
    fireAll: () => pending.splice(0).forEach((t) => t.fn()),
    count: () => pending.length,
  };
};

describe('createClientLogSender', () => {
  it('batches entries and sends them together when the timer fires', async () => {
    const timer = manualTimer();
    const post = vi.fn(async (_entries: ClientLogEntry[]) => true);
    const s = createClientLogSender({ post, schedule: timer.schedule, cancel: timer.cancel });
    s.push(entry(1));
    s.push(entry(2));
    expect(post).not.toHaveBeenCalled();
    expect(timer.count()).toBe(1); // one timer for the whole batch
    timer.fireAll();
    await s.flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0].map((e: ClientLogEntry) => e.message)).toEqual(['m1', 'm2']);
    expect(s.waiting()).toBe(0);
  });

  it('keeps entries when the server cannot be reached, and sends them with the next batch', async () => {
    const timer = manualTimer();
    let up = false;
    const post = vi.fn(async (_entries: ClientLogEntry[]) => up);
    const s = createClientLogSender({ post, schedule: timer.schedule, cancel: timer.cancel });
    s.push(entry(1));
    await s.flush();
    expect(s.waiting()).toBe(1);
    expect(timer.count()).toBe(1); // tries again later, not in a tight loop
    up = true;
    s.push(entry(2));
    await s.flush();
    expect(s.waiting()).toBe(0);
    expect(post.mock.calls[post.mock.calls.length - 1][0].map((e: ClientLogEntry) => e.message)).toEqual(['m1', 'm2']);
  });

  it('drops the oldest entries first when too many are waiting', async () => {
    const timer = manualTimer();
    const post = vi.fn(async (_entries: ClientLogEntry[]) => false);
    const s = createClientLogSender({ post, schedule: timer.schedule, cancel: timer.cancel, maxWaiting: 3 });
    for (let i = 1; i <= 5; i++) s.push(entry(i));
    expect(s.waiting()).toBe(3);
    await s.flush();
    expect(post.mock.calls[0][0].map((e: ClientLogEntry) => e.message)).toEqual(['m3', 'm4', 'm5']);
  });

  it('never throws, even if posting does', async () => {
    const timer = manualTimer();
    const s = createClientLogSender({
      post: async () => {
        throw new Error('network');
      },
      schedule: timer.schedule,
      cancel: timer.cancel,
    });
    s.push(entry(1));
    await expect(s.flush()).resolves.toBeUndefined();
    expect(s.waiting()).toBe(1);
  });

  it('sends at most 20 entries per request and the rest follow', async () => {
    const timer = manualTimer();
    const post = vi.fn(async (_entries: ClientLogEntry[]) => true);
    const s = createClientLogSender({ post, schedule: timer.schedule, cancel: timer.cancel });
    for (let i = 0; i < 45; i++) s.push(entry(i));
    await s.flush();
    expect(post.mock.calls[0][0]).toHaveLength(20);
    expect(s.waiting()).toBe(25);
    timer.fireAll();
    await s.flush();
    await s.flush();
    expect(s.waiting()).toBe(0);
  });
});
