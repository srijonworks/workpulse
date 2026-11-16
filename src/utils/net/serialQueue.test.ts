import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobTimedOut, createSerialQueue } from './serialQueue';

afterEach(() => vi.useRealTimers());

describe('createSerialQueue', () => {
  it('runs jobs one at a time, in the order they were added', async () => {
    const q = createSerialQueue({ jobTimeoutMs: 1000 });
    const order: string[] = [];
    let release!: () => void;
    const first = q.run(async () => {
      order.push('a start');
      await new Promise<void>((resolve) => (release = resolve));
      order.push('a end');
    });
    const second = q.run(async () => {
      order.push('b');
    });
    await Promise.resolve();
    expect(order).toEqual(['a start']);
    expect(q.pending()).toBe(2);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a start', 'a end', 'b']);
    expect(q.pending()).toBe(0);
  });

  it('abandons a job that hangs, frees the queue, and runs the next job', async () => {
    vi.useFakeTimers();
    const q = createSerialQueue({ jobTimeoutMs: 5000 });
    const hung = q.run(() => new Promise<never>(() => {}));
    const next = q.run(async () => 'ran');
    const hungResult = hung.then(() => 'resolved', (e) => e);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await hungResult).toBeInstanceOf(JobTimedOut);
    expect(await next).toBe('ran');
    expect(q.pending()).toBe(0);
  });

  it('keeps going after a job that throws, and reports the error to that job only', async () => {
    const q = createSerialQueue({ jobTimeoutMs: 1000 });
    const bad = q.run(async () => {
      throw new Error('boom');
    });
    const good = q.run(async () => 'fine');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('fine');
  });

  it('survives a job that throws before it returns a promise', async () => {
    const q = createSerialQueue({ jobTimeoutMs: 1000 });
    const bad = q.run((() => {
      throw new Error('sync boom');
    }) as () => Promise<never>);
    await expect(bad).rejects.toThrow('sync boom');
    await expect(q.run(async () => 1)).resolves.toBe(1);
  });

  it('leaves no timer behind once the jobs are done', async () => {
    vi.useFakeTimers();
    const q = createSerialQueue({ jobTimeoutMs: 60_000 });
    await q.run(async () => 1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
