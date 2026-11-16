// Only one window may write the app's data. Two windows on the same address each hold the whole lists in memory and
// each write them back, so the one that saves last wins and the other's work vanishes. The browser's Web Locks keep
// one writer: the first window holds the lock for as long as it lives, a second one finds it taken and stays read-only
// until the user chooses "Use this window", which takes the lock over.

/** The part of navigator.locks used here (so tests can supply a stand-in). */
export interface LocksLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: object | null) => unknown,
  ): Promise<unknown>;
}

export type WriterLockState = 'held' | 'taken-elsewhere' | 'unsupported';

export interface WriterLock {
  state: WriterLockState;
  release(): void;
}

export const WRITER_LOCK_NAME = 'workpulse-writer';

export function acquireWriterLock(
  locks: LocksLike | undefined,
  opts: { name?: string; steal?: boolean; retryMs?: number; retries?: number; onLost?: () => void } = {},
): Promise<WriterLock> {
  const name = opts.name ?? WRITER_LOCK_NAME;
  if (!locks) return Promise.resolve({ state: 'unsupported', release: () => {} });

  return new Promise((resolve) => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    let held = false;

    // A page that was just reloaded or re-mounted may still be handing the lock back: look twice before giving up.
    const attempt = (retriesLeft: number) => {
      locks
        .request(name, opts.steal ? { steal: true } : { ifAvailable: true }, (lock) => {
          if (!lock) {
            if (retriesLeft > 0) {
              setTimeout(() => attempt(retriesLeft - 1), opts.retryMs ?? 150);
            } else {
              resolve({ state: 'taken-elsewhere', release: () => {} });
            }
            return undefined;
          }
          held = true;
          resolve({ state: 'held', release: () => release() });
          return hold; // keeps the lock until it is released or the page closes
        })
        .catch(() => {
          // Another window stole the lock from this one, or locks are not usable here.
          if (held) opts.onLost?.();
          else resolve({ state: 'unsupported', release: () => {} });
        });
    };
    attempt(opts.retries ?? 1);
  });
}
