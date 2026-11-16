// Runs jobs one at a time, in order, and never lets one stuck job block the rest: a job that has not finished after
// `jobTimeoutMs` is abandoned (its own promise rejects with JobTimedOut) and the next job starts.

export class JobTimedOut extends Error {
  constructor() {
    super('The job took too long and was abandoned.');
    this.name = 'JobTimedOut';
  }
}

export interface SerialQueue {
  run<T>(job: () => Promise<T>): Promise<T>;
  /** Jobs waiting or running. */
  pending(): number;
}

export function createSerialQueue(opts: { jobTimeoutMs: number }): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  const withDeadline = <T>(job: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new JobTimedOut()), opts.jobTimeoutMs);
      let started: Promise<T>;
      try {
        started = job();
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      started.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });

  return {
    run<T>(job: () => Promise<T>): Promise<T> {
      pending++;
      const result = tail.then(() => withDeadline(job));
      tail = result.catch(() => undefined);
      return result.finally(() => {
        pending--;
      });
    },
    pending: () => pending,
  };
}
