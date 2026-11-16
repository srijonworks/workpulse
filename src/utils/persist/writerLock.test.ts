import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireWriterLock, type LocksLike } from './writerLock';

afterEach(() => vi.useRealTimers());

// Behaves like navigator.locks for one lock name: exclusive, ifAvailable returns null when taken, steal takes it over.
function fakeLocks(): LocksLike & { holders: number } {
  let current: { release: () => void; reject: (e: Error) => void } | null = null;
  const api = {
    get holders() {
      return current ? 1 : 0;
    },
    request(_name: string, options: { ifAvailable?: boolean; steal?: boolean }, callback: (lock: object | null) => unknown) {
      if (current && options.ifAvailable) return Promise.resolve(callback(null));
      if (current && options.steal) current.reject(new DOMException('The lock was stolen.', 'AbortError'));
      return new Promise((resolve, reject) => {
        const entry = { release: () => {}, reject: (e: Error) => reject(e) };
        current = entry;
        Promise.resolve(callback({})).then(
          (v) => {
            if (current === entry) current = null;
            resolve(v);
          },
          (e) => reject(e),
        );
      });
    },
  };
  return api;
}

describe('acquireWriterLock', () => {
  it('gives the first window the lock and holds it until released', async () => {
    const locks = fakeLocks();
    const a = await acquireWriterLock(locks);
    expect(a.state).toBe('held');
    expect(locks.holders).toBe(1);
    a.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(locks.holders).toBe(0);
  });

  it('leaves a second window read-only while the first holds the lock', async () => {
    vi.useFakeTimers();
    const locks = fakeLocks();
    const a = await acquireWriterLock(locks);
    const second = acquireWriterLock(locks, { retryMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    expect((await second).state).toBe('taken-elsewhere');
    expect(a.state).toBe('held');
  });

  it('takes the lock when the earlier holder lets go during the short second look (a window that was just reloaded)', async () => {
    vi.useFakeTimers();
    const locks = fakeLocks();
    const a = await acquireWriterLock(locks);
    const second = acquireWriterLock(locks, { retryMs: 100 });
    a.release();
    await vi.advanceTimersByTimeAsync(150);
    expect((await second).state).toBe('held');
  });

  it('"Use this window" steals the lock, and the old holder is told it lost it', async () => {
    const locks = fakeLocks();
    const onLost = vi.fn();
    const first = await acquireWriterLock(locks, { onLost });
    expect(first.state).toBe('held');
    const taker = await acquireWriterLock(locks, { steal: true });
    expect(taker.state).toBe('held');
    await Promise.resolve();
    await Promise.resolve();
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('does not block anything when the browser has no Web Locks', async () => {
    expect((await acquireWriterLock(undefined)).state).toBe('unsupported');
  });

  it('treats a locks API that errors as unsupported, never as a reason to freeze', async () => {
    const broken: LocksLike = { request: () => Promise.reject(new Error('SecurityError')) };
    expect((await acquireWriterLock(broken)).state).toBe('unsupported');
  });
});
