// The save engine: every write of the app's data goes through here, so a save that fails is never lost and never
// silent. It keeps what could not be written and retries it, writes related keys as one group (all or nothing),
// holds back writes to a key whose stored value could not be read (so an empty fallback never replaces real data),
// and can freeze all writes (a second window must not overwrite the first). Pure: the storage is passed in.

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Storage that can also be listed, to estimate how full it is. */
export interface KVEnumerable extends KV {
  readonly length: number;
  key(index: number): string | null;
}

export type SaveFail = 'quota' | 'unavailable' | 'frozen' | 'blocked';

export type SaveResult = { ok: true } | { ok: false; error: string; kind?: SaveFail };

export const SAVE_FAIL_MESSAGES: Record<SaveFail, string> = {
  quota: 'This browser has no room left to save your changes.',
  unavailable: 'This browser is not letting WorkPulse save.',
  frozen: 'WorkPulse is open in another window, so this one is read-only.',
  blocked: 'Part of your data could not be read, so WorkPulse is not changing it.',
};

export const META_KEY = 'workpulse_meta';
export const PROBE_KEY = 'workpulse_probe';
export const STORAGE_LIMIT_BYTES = 5 * 1024 * 1024;
export const STORAGE_WARN_RATIO = 0.8;

export interface StorageMeta {
  v: 1;
  profileId: string;
  rev: number;
  savedAt: string;
  /** Every data key that has been saved. A key listed here but missing from storage means data was lost. */
  keys: string[];
}

export interface EngineStatus {
  /** Keys whose latest value is not in storage yet (kept, and retried). */
  dirtyKeys: string[];
  /** Keys that could not be read; writes to them are held. */
  blockedKeys: string[];
  frozen: boolean;
  /** True while anything the user did is not in storage. */
  notSaved: boolean;
  lastError?: string;
  lastErrorKind?: SaveFail;
  lastOkAt?: number;
  lastFailAt?: number;
  rev: number;
  profileId: string;
}

export function classifySaveError(e: unknown): SaveFail {
  const err = (e ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014 || /quota/i.test(String(err.message ?? ''))) {
    return 'quota';
  }
  return 'unavailable';
}

/** Bytes the storage uses, counting two bytes per character of every key and value (what browsers do). */
export function storageUsageBytes(kv: KVEnumerable): number {
  let chars = 0;
  for (let i = 0; i < kv.length; i++) {
    const k = kv.key(i);
    if (k === null) continue;
    chars += k.length + (kv.getItem(k)?.length ?? 0);
  }
  return chars * 2;
}

export const storageNearlyFull = (bytes: number): boolean => bytes >= STORAGE_LIMIT_BYTES * STORAGE_WARN_RATIO;

const newProfileId = (): string => `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface Engine {
  /** Saves one key (a value, serialised as JSON). A failure keeps the value and is retried. */
  save(key: string, value: unknown): SaveResult;
  /** Saves several keys as one group: all of them or none. A failure keeps all the values and they are retried together. */
  saveGroup(entries: [string, unknown][]): SaveResult;
  /** Like saveGroup, but a failure keeps nothing: the caller decides what to do (the phone merge, before it confirms). */
  trySave(entries: [string, unknown][]): SaveResult;
  /** Writes everything that is waiting, as one group. */
  retry(): SaveResult;
  /** Holds back writes to a key whose stored value could not be read. */
  block(key: string): void;
  /** `discardPending: true` forgets what was held (the key was restored from a copy); false writes it. */
  unblock(key: string, opts?: { discardPending?: boolean }): void;
  freeze(): void;
  unfreeze(): void;
  /** Checks that the storage can be written and read at all. */
  probe(): SaveResult;
  /** Runs the flush functions (they save things that are kept in memory), then retries. For quit, suspend, crash. */
  flushAll(): SaveResult;
  registerFlush(fn: () => void): () => void;
  /** Takes over the identity found in storage at load. */
  adopt(meta: Pick<StorageMeta, 'profileId' | 'rev' | 'keys'>): void;
  status(): EngineStatus;
  subscribe(fn: () => void): () => void;
}

export function createEngine(opts: { kv: KV; now?: () => number; newId?: () => string }): Engine {
  const kv = opts.kv;
  const now = opts.now ?? Date.now;

  const pending = new Map<string, string | null>();
  const blocked = new Set<string>();
  const known = new Set<string>();
  const flushers = new Set<() => void>();
  const listeners = new Set<() => void>();
  let frozen = false;
  let rev = 0;
  let profileId = (opts.newId ?? newProfileId)();
  let lastError: string | undefined;
  let lastErrorKind: SaveFail | undefined;
  let lastOkAt: number | undefined;
  let lastFailAt: number | undefined;
  let retrying = false;

  const compute = (): EngineStatus => ({
    dirtyKeys: [...pending.keys()].sort(),
    blockedKeys: [...blocked].sort(),
    frozen,
    notSaved: pending.size > 0,
    lastError,
    lastErrorKind,
    lastOkAt,
    lastFailAt,
    rev,
    profileId,
  });
  let snapshot = compute();
  let notifyQueued = false;
  // The status is up to date at once, but listeners hear about it a moment later: a save can happen while React is
  // rendering (inside a state updater), and a listener that sets state then would be an error ("update a component
  // while rendering another").
  const notify = () => {
    snapshot = compute();
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch {
          // a listener's problem is not the save's
        }
      }
    });
  };

  const fail = (kind: SaveFail, error?: string): SaveResult => ({ ok: false, kind, error: error || SAVE_FAIL_MESSAGES[kind] });

  const raw = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));

  const safeGet = (key: string): string | null => {
    try {
      return kv.getItem(key);
    } catch {
      return null;
    }
  };

  // Writes the entries (a null value removes the key). With more than one entry, a failure puts every key back as it was.
  const writeGroup = (entries: [string, string | null][]): SaveResult => {
    const before = entries.length > 1 ? new Map(entries.map(([k]) => [k, safeGet(k)])) : null;
    const done: string[] = [];
    try {
      for (const [k, v] of entries) {
        if (v === null) kv.removeItem(k);
        else kv.setItem(k, v);
        done.push(k);
      }
    } catch (e) {
      if (before) {
        for (const k of done) {
          try {
            const old = before.get(k) ?? null;
            if (old === null) kv.removeItem(k);
            else kv.setItem(k, old);
          } catch {
            // best effort
          }
        }
      }
      return fail(classifySaveError(e));
    }
    return { ok: true };
  };

  const recordOk = (keys: string[]) => {
    rev++;
    lastOkAt = now();
    for (const k of keys) known.add(k);
    // The identity is written last and is only advice: if it cannot be written, the data above is still saved.
    try {
      kv.setItem(META_KEY, JSON.stringify({ v: 1, profileId, rev, savedAt: new Date(now()).toISOString(), keys: [...known].sort() } satisfies StorageMeta));
    } catch {
      // advisory
    }
  };

  const recordFail = (r: Extract<SaveResult, { ok: false }>) => {
    lastError = r.error;
    lastErrorKind = r.kind;
    lastFailAt = now();
  };

  const retry = (): SaveResult => {
    if (frozen) return fail('frozen');
    const entries = [...pending].filter(([k]) => !blocked.has(k));
    if (entries.length === 0) return { ok: true };
    const r = writeGroup(entries);
    if (r.ok) {
      for (const [k] of entries) pending.delete(k);
      recordOk(entries.map(([k]) => k));
    } else {
      recordFail(r);
    }
    notify();
    return r;
  };

  const saveEntries = (entries: [string, unknown][], keepOnFailure: boolean): SaveResult => {
    if (frozen) return fail('frozen');
    const all = entries.map(([k, v]) => [k, raw(v)] as [string, string | null]);
    const writable = all.filter(([k]) => !blocked.has(k));
    const held = all.filter(([k]) => blocked.has(k));
    if (keepOnFailure) for (const [k, v] of held) pending.set(k, v);

    let result: SaveResult = held.length > 0 ? fail('blocked') : { ok: true };
    if (writable.length > 0) {
      const r = writeGroup(writable);
      if (r.ok) {
        for (const [k] of writable) pending.delete(k);
        recordOk(writable.map(([k]) => k));
      } else {
        if (keepOnFailure) for (const [k, v] of writable) pending.set(k, v);
        recordFail(r);
        result = r;
      }
    }
    if (!result.ok && result.kind === 'blocked') recordFail(result);
    notify();
    // Something else is waiting and storage works again: write it too, so one good save heals the rest.
    if (result.ok && pending.size > 0 && !retrying) {
      retrying = true;
      try {
        retry();
      } finally {
        retrying = false;
      }
    }
    return result;
  };

  return {
    save: (key, value) => saveEntries([[key, value]], true),
    saveGroup: (entries) => saveEntries(entries, true),
    trySave: (entries) => saveEntries(entries, false),
    retry,
    block(key) {
      blocked.add(key);
      notify();
    },
    unblock(key, o) {
      blocked.delete(key);
      if (o?.discardPending) pending.delete(key);
      notify();
    },
    freeze() {
      frozen = true;
      notify();
    },
    unfreeze() {
      frozen = false;
      notify();
    },
    probe() {
      try {
        kv.setItem(PROBE_KEY, '1');
        const ok = kv.getItem(PROBE_KEY) === '1';
        kv.removeItem(PROBE_KEY);
        return ok ? { ok: true } : fail('unavailable');
      } catch (e) {
        return fail(classifySaveError(e));
      }
    },
    flushAll() {
      for (const fn of [...flushers]) {
        try {
          fn();
        } catch {
          // one flusher failing must not stop the others
        }
      }
      return retry();
    },
    registerFlush(fn) {
      flushers.add(fn);
      return () => {
        flushers.delete(fn);
      };
    },
    adopt(meta) {
      profileId = meta.profileId;
      rev = Math.max(rev, meta.rev);
      for (const k of meta.keys) known.add(k);
      notify();
    },
    status: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** Reads the identity record from storage, or null when it is missing or unreadable. */
export function readMeta(kv: KV): StorageMeta | null {
  try {
    const text = kv.getItem(META_KEY);
    if (text === null) return null;
    const m = JSON.parse(text) as Partial<StorageMeta>;
    if (m && m.v === 1 && typeof m.profileId === 'string' && typeof m.rev === 'number' && Array.isArray(m.keys) && m.keys.every((k) => typeof k === 'string')) {
      return { v: 1, profileId: m.profileId, rev: m.rev, savedAt: typeof m.savedAt === 'string' ? m.savedAt : '', keys: m.keys };
    }
    return null;
  } catch {
    return null;
  }
}
