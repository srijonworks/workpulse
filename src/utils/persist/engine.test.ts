import { describe, expect, it, vi } from 'vitest';
import {
  META_KEY,
  PROBE_KEY,
  STORAGE_LIMIT_BYTES,
  classifySaveError,
  createEngine,
  readMeta,
  storageNearlyFull,
  storageUsageBytes,
  type KVEnumerable,
} from './engine';

// A storage that can be told to fail, like a full or blocked browser store.
class FakeKV implements KVEnumerable {
  map = new Map<string, string>();
  failures = 0;
  failWith: unknown = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  failOnly: string | null = null;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    if (this.failures > 0 && (this.failOnly === null || this.failOnly === k)) {
      this.failures--;
      throw this.failWith;
    }
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  snapshot() {
    return JSON.stringify([...this.map].sort());
  }
}

const make = () => {
  const kv = new FakeKV();
  let t = 1_000;
  const engine = createEngine({ kv, now: () => t++, newId: () => 'profile-test' });
  return { kv, engine };
};

describe('saving', () => {
  it('writes the value as JSON, then the identity record with a new revision', () => {
    const { kv, engine } = make();
    expect(engine.save('workpulse_logs', [{ id: 'a' }])).toEqual({ ok: true });
    expect(kv.getItem('workpulse_logs')).toBe('[{"id":"a"}]');
    const meta = readMeta(kv);
    expect(meta).toMatchObject({ v: 1, profileId: 'profile-test', rev: 1, keys: ['workpulse_logs'] });
    engine.save('workpulse_tags', ['x']);
    expect(readMeta(kv)).toMatchObject({ rev: 2, keys: ['workpulse_logs', 'workpulse_tags'] });
    expect(engine.status().notSaved).toBe(false);
  });

  it('removes a key when the value is undefined', () => {
    const { kv, engine } = make();
    engine.save('k', 1);
    engine.save('k', undefined);
    expect(kv.getItem('k')).toBeNull();
  });

  it('does not fail the save when only the identity record cannot be written', () => {
    const { kv, engine } = make();
    kv.failOnly = META_KEY;
    kv.failures = 5;
    expect(engine.save('workpulse_logs', [1])).toEqual({ ok: true });
    expect(kv.getItem('workpulse_logs')).toBe('[1]');
    expect(engine.status().notSaved).toBe(false);
  });
});

describe('a save that fails is kept and retried', () => {
  it('reports the failure in plain words, keeps the latest value, and writes it when storage works again', () => {
    const { kv, engine } = make();
    kv.failures = 2;
    const first = engine.save('workpulse_logs', ['v1']);
    expect(first).toMatchObject({ ok: false, kind: 'quota' });
    if (!first.ok) expect(first.error).toMatch(/no room left/);
    expect(engine.save('workpulse_logs', ['v2'])).toMatchObject({ ok: false, kind: 'quota' });
    expect(kv.getItem('workpulse_logs')).toBeNull();
    expect(engine.status()).toMatchObject({ notSaved: true, dirtyKeys: ['workpulse_logs'], lastErrorKind: 'quota' });

    expect(engine.retry()).toEqual({ ok: true });
    expect(kv.getItem('workpulse_logs')).toBe('["v2"]'); // the newest value, not the first one
    expect(engine.status()).toMatchObject({ notSaved: false, dirtyKeys: [] });
  });

  it('one good save heals the other keys that were waiting', () => {
    const { kv, engine } = make();
    kv.failures = 1;
    engine.save('workpulse_logs', ['waiting']);
    expect(engine.status().dirtyKeys).toEqual(['workpulse_logs']);
    expect(engine.save('workpulse_tags', ['now fine'])).toEqual({ ok: true });
    expect(kv.getItem('workpulse_logs')).toBe('["waiting"]');
    expect(engine.status().notSaved).toBe(false);
  });

  it('says "unavailable" (not "no room") when the browser blocks storage altogether', () => {
    const { kv, engine } = make();
    kv.failWith = new DOMException('The operation is insecure.', 'SecurityError');
    kv.failures = 1;
    expect(engine.save('k', 1)).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('keeps nothing when trySave fails (the caller decides)', () => {
    const { kv, engine } = make();
    kv.failures = 1;
    expect(engine.trySave([['workpulse_backlog', [1]]])).toMatchObject({ ok: false, kind: 'quota' });
    expect(engine.status().notSaved).toBe(false);
    expect(engine.retry()).toEqual({ ok: true });
    expect(kv.getItem('workpulse_backlog')).toBeNull();
  });

  it('notifies listeners when the state changes, and the status object stays the same in between', async () => {
    const { kv, engine } = make();
    const seen = vi.fn();
    engine.subscribe(seen);
    const before = engine.status();
    expect(engine.status()).toBe(before);
    kv.failures = 1;
    engine.save('k', 1);
    expect(engine.status()).not.toBe(before); // the status is current at once
    expect(seen).not.toHaveBeenCalled(); // listeners hear a moment later, never in the middle of a render
    await Promise.resolve();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(engine.status()).not.toBe(before);
    const after = engine.status();
    expect(engine.status()).toBe(after);
  });
});

describe('groups are all or nothing', () => {
  it('puts every key back as it was when one write fails, keeps all the values, and writes them together later', () => {
    const { kv, engine } = make();
    engine.save('workpulse_backlog', ['old task']);
    engine.save('workpulse_logs', ['old log']);
    const before = kv.snapshot();
    kv.failOnly = 'workpulse_logs';
    kv.failures = 1;
    const r = engine.saveGroup([
      ['workpulse_backlog', ['task now marked logged']],
      ['workpulse_logs', ['old log', 'new log']],
    ]);
    expect(r).toMatchObject({ ok: false, kind: 'quota' });
    expect(kv.snapshot()).toBe(before); // byte for byte: the task was NOT left marked as logged without its log
    expect(engine.status().dirtyKeys).toEqual(['workpulse_backlog', 'workpulse_logs']);

    expect(engine.retry()).toEqual({ ok: true });
    expect(kv.getItem('workpulse_backlog')).toBe('["task now marked logged"]');
    expect(kv.getItem('workpulse_logs')).toBe('["old log","new log"]');
  });
});

describe('a key that could not be read is never overwritten', () => {
  it('holds the writes to a blocked key, and the other keys still save', () => {
    const { kv, engine } = make();
    kv.map.set('workpulse_logs', '{broken');
    engine.block('workpulse_logs');
    expect(engine.save('workpulse_logs', [])).toMatchObject({ ok: false, kind: 'blocked' });
    expect(kv.getItem('workpulse_logs')).toBe('{broken');
    expect(engine.save('workpulse_tags', ['t'])).toEqual({ ok: true });
    expect(kv.getItem('workpulse_logs')).toBe('{broken'); // still untouched after another key's good save
    expect(engine.retry()).toEqual({ ok: true });
    expect(kv.getItem('workpulse_logs')).toBe('{broken');
    expect(engine.status()).toMatchObject({ blockedKeys: ['workpulse_logs'], notSaved: true });
  });

  it('drops what was held when the key is restored from a copy', () => {
    const { kv, engine } = make();
    engine.block('workpulse_logs');
    engine.save('workpulse_logs', ['held']);
    kv.map.set('workpulse_logs', '["restored"]');
    engine.unblock('workpulse_logs', { discardPending: true });
    expect(engine.retry()).toEqual({ ok: true });
    expect(kv.getItem('workpulse_logs')).toBe('["restored"]');
    expect(engine.status()).toMatchObject({ blockedKeys: [], notSaved: false });
  });

  it('writes what was held when the user chooses to start empty', () => {
    const { kv, engine } = make();
    engine.block('workpulse_logs');
    engine.save('workpulse_logs', ['start again']);
    engine.unblock('workpulse_logs');
    expect(engine.retry()).toEqual({ ok: true });
    expect(kv.getItem('workpulse_logs')).toBe('["start again"]');
  });
});

describe('freezing', () => {
  it('writes nothing and keeps nothing while frozen, and works again after', () => {
    const { kv, engine } = make();
    engine.freeze();
    expect(engine.save('k', 1)).toMatchObject({ ok: false, kind: 'frozen' });
    expect(engine.retry()).toMatchObject({ ok: false, kind: 'frozen' });
    expect(kv.getItem('k')).toBeNull();
    expect(engine.status()).toMatchObject({ frozen: true, notSaved: false });
    engine.unfreeze();
    expect(engine.save('k', 1)).toEqual({ ok: true });
  });
});

describe('probe, flush, identity', () => {
  it('finds storage that cannot be written, and leaves no probe key behind', () => {
    const { kv, engine } = make();
    expect(engine.probe()).toEqual({ ok: true });
    expect(kv.getItem(PROBE_KEY)).toBeNull();
    kv.failWith = new DOMException('insecure', 'SecurityError');
    kv.failures = 1;
    expect(engine.probe()).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('runs every flusher even if one throws, then retries what is waiting', () => {
    const { kv, engine } = make();
    kv.failures = 1;
    engine.save('workpulse_backlog', ['timers']);
    const ran: string[] = [];
    engine.registerFlush(() => {
      throw new Error('broken flusher');
    });
    const off = engine.registerFlush(() => ran.push('second'));
    expect(engine.flushAll()).toEqual({ ok: true });
    expect(ran).toEqual(['second']);
    expect(kv.getItem('workpulse_backlog')).toBe('["timers"]');
    off();
    engine.flushAll();
    expect(ran).toEqual(['second']);
  });

  it('takes over the identity and revision found in storage', () => {
    const { kv, engine } = make();
    engine.adopt({ profileId: 'profile-earlier', rev: 40, keys: ['workpulse_logs'] });
    engine.save('workpulse_tags', []);
    expect(readMeta(kv)).toMatchObject({ profileId: 'profile-earlier', rev: 41, keys: ['workpulse_logs', 'workpulse_tags'] });
  });

  it('readMeta ignores missing or damaged records', () => {
    const { kv } = make();
    expect(readMeta(kv)).toBeNull();
    kv.map.set(META_KEY, '{nope');
    expect(readMeta(kv)).toBeNull();
    kv.map.set(META_KEY, JSON.stringify({ v: 2 }));
    expect(readMeta(kv)).toBeNull();
  });
});

describe('error kinds and storage use', () => {
  it('recognises a full store however the browser words it', () => {
    expect(classifySaveError(new DOMException('x', 'QuotaExceededError'))).toBe('quota');
    expect(classifySaveError({ code: 22 })).toBe('quota');
    expect(classifySaveError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe('quota');
    expect(classifySaveError(new Error('The quota has been exceeded'))).toBe('quota');
    expect(classifySaveError(new DOMException('x', 'SecurityError'))).toBe('unavailable');
    expect(classifySaveError(undefined)).toBe('unavailable');
  });

  it('estimates the bytes in use and warns at 80 % of the usual 5 MB', () => {
    const kv = new FakeKV();
    kv.map.set('ab', 'cdef'); // 6 characters, 12 bytes
    expect(storageUsageBytes(kv)).toBe(12);
    expect(storageNearlyFull(STORAGE_LIMIT_BYTES * 0.79)).toBe(false);
    expect(storageNearlyFull(STORAGE_LIMIT_BYTES * 0.8)).toBe(true);
  });
});
