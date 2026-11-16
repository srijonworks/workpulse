import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalKeysText, countsOf, cleanKeys, type CopyFile, type CopyMeta } from '../utils/persist/copyFormat';
import type { DataKey } from '../utils/persist/keys';

// Copies of the user's data on disk (<data folder>/backups/<app address>/). The browser's storage can be wiped or
// damaged; these files are what the app restores from. Every write goes to a temp file first and is then renamed, the
// file before it is kept as prev.json, and each file carries a checksum that is verified whenever it is read, so a
// crash in the middle of a write never leaves the only copy unreadable.

const DAILY_KEEP = 14;
const SAFETY_KEEP = 10;
const DAILY_REFRESH_MS = 30 * 60 * 1000;

export interface CopyInput {
  profileId: string;
  rev: number;
  keys: Partial<Record<DataKey, string>>;
  /** The user chose to let this browser profile replace the copy of another one. */
  takeover?: boolean;
}

export type WriteResult =
  | { ok: true; written: boolean; meta: CopyMeta }
  | { ok: false; code: 'stale' | 'other-profile' | 'invalid' | 'disk'; message: string; current?: CopyMeta };

export type ReadResult = { copy: CopyFile | null; damaged: boolean };

export interface LocalCopy {
  write(origin: string, input: CopyInput): Promise<WriteResult>;
  /** The newest copy that passes its checksum (latest, else prev). `damaged` says a file was found but unreadable. */
  read(origin: string): Promise<ReadResult>;
  /** A copy taken before something destructive (reset, import, restore). Never replaced by the rolling ones. */
  safety(origin: string, keys: Partial<Record<DataKey, string>>, reason: string, profileId?: string): Promise<WriteResult>;
}

const hashOf = (keys: Partial<Record<string, string>>): string => createHash('sha256').update(canonicalKeysText(keys)).digest('hex');

/** "localhost:3000" becomes a safe folder name. */
export function originFolder(origin: string): string {
  const cleaned = origin.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

const safeReason = (r: string): string => r.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'copy';

export function parseCopyFile(text: string): CopyFile | null {
  try {
    const o = JSON.parse(text) as Partial<CopyFile>;
    if (!o || o.format !== 1 || typeof o.profileId !== 'string' || typeof o.rev !== 'number' || typeof o.origin !== 'string') return null;
    const keys = cleanKeys(o.keys);
    if (!keys || typeof o.sha256 !== 'string' || o.sha256 !== hashOf(keys)) return null;
    return {
      format: 1,
      profileId: o.profileId,
      origin: o.origin,
      rev: o.rev,
      savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
      counts: countsOf(keys),
      sha256: o.sha256,
      keys,
    };
  } catch {
    return null;
  }
}

export const metaOf = ({ keys: _keys, ...meta }: CopyFile): CopyMeta => meta;

export function createLocalCopy(root: string, opts: { now?: () => Date } = {}): LocalCopy {
  const now = opts.now ?? (() => new Date());
  // One write at a time per folder, so two requests cannot interleave their renames.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(dir: string, job: () => Promise<T>): Promise<T> => {
    const run = (queues.get(dir) ?? Promise.resolve()).then(job, job);
    queues.set(dir, run.catch(() => undefined));
    return run;
  };

  const readFile = async (file: string): Promise<{ copy: CopyFile | null; exists: boolean }> => {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return { copy: null, exists: false };
    }
    return { copy: parseCopyFile(text), exists: true };
  };

  const writeAtomic = async (file: string, text: string): Promise<void> => {
    const tmp = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  };

  const prune = async (dir: string, keep: number) => {
    try {
      const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
      for (const n of names.slice(0, Math.max(0, names.length - keep))) await fs.rm(path.join(dir, n), { force: true });
    } catch {
      // pruning is housekeeping; a failure here must not fail the save
    }
  };

  const build = (origin: string, input: CopyInput): CopyFile => {
    const keys = cleanKeys(input.keys) ?? {};
    return { format: 1, profileId: input.profileId, origin, rev: input.rev, savedAt: now().toISOString(), counts: countsOf(keys), sha256: hashOf(keys), keys };
  };

  const dirOf = (origin: string) => path.join(root, originFolder(origin));

  const read = async (origin: string): Promise<ReadResult> => {
    const dir = dirOf(origin);
    let damaged = false;
    for (const name of ['latest.json', 'prev.json']) {
      const r = await readFile(path.join(dir, name));
      if (r.copy) return { copy: r.copy, damaged };
      if (r.exists) damaged = true;
    }
    return { copy: null, damaged };
  };

  return {
    read,

    write(origin, input) {
      const dir = dirOf(origin);
      return serial(dir, async (): Promise<WriteResult> => {
        if (!input.profileId || !Number.isFinite(input.rev) || !cleanKeys(input.keys)) {
          return { ok: false, code: 'invalid', message: 'The copy had nothing usable in it.' };
        }
        try {
          await fs.mkdir(path.join(dir, 'daily'), { recursive: true });
          await fs.mkdir(path.join(dir, 'safety'), { recursive: true });
          const cur = (await read(origin)).copy;
          if (cur && cur.profileId !== input.profileId && !input.takeover) {
            return { ok: false, code: 'other-profile', message: 'The saved copy belongs to a different browser profile.', current: metaOf(cur) };
          }
          if (cur && cur.profileId === input.profileId) {
            if (input.rev < cur.rev) return { ok: false, code: 'stale', message: 'The saved copy is newer than this one.', current: metaOf(cur) };
            if (input.rev === cur.rev) return { ok: true, written: false, meta: metaOf(cur) };
          }
          const file = build(origin, input);
          if (cur && cur.profileId !== input.profileId) {
            // Taking over: the copy that is being replaced is kept.
            await writeAtomic(path.join(dir, 'safety', `${now().toISOString().replace(/[:.]/g, '-')}-replaced.json`), JSON.stringify(cur));
            await prune(path.join(dir, 'safety'), SAFETY_KEEP);
          }
          const text = JSON.stringify(file);
          const next = path.join(dir, 'latest.json.new');
          await writeAtomic(next, text);
          if (cur) await fs.copyFile(path.join(dir, 'latest.json'), path.join(dir, 'prev.json')).catch(() => undefined);
          await fs.rename(next, path.join(dir, 'latest.json'));

          const day = file.savedAt.slice(0, 10);
          const dailyFile = path.join(dir, 'daily', `${day}.json`);
          const stat = await fs.stat(dailyFile).catch(() => null);
          if (!stat || now().getTime() - stat.mtimeMs > DAILY_REFRESH_MS) {
            await writeAtomic(dailyFile, text);
            await prune(path.join(dir, 'daily'), DAILY_KEEP);
          }
          return { ok: true, written: true, meta: metaOf(file) };
        } catch (e) {
          const code = (e as NodeJS.ErrnoException)?.code;
          const why = code === 'ENOSPC' ? 'The disk is full.' : code === 'EACCES' || code === 'EPERM' ? 'WorkPulse is not allowed to write to its folder.' : 'The copy could not be written to disk.';
          return { ok: false, code: 'disk', message: why };
        }
      });
    },

    safety(origin, keys, reason, profileId = 'unknown') {
      const dir = dirOf(origin);
      return serial(dir, async (): Promise<WriteResult> => {
        const clean = cleanKeys(keys);
        if (!clean) return { ok: false, code: 'invalid', message: 'There was nothing to copy.' };
        try {
          await fs.mkdir(path.join(dir, 'safety'), { recursive: true });
          const file = build(origin, { profileId, rev: 0, keys: clean });
          await writeAtomic(path.join(dir, 'safety', `${now().toISOString().replace(/[:.]/g, '-')}-${safeReason(reason)}.json`), JSON.stringify(file));
          await prune(path.join(dir, 'safety'), SAFETY_KEEP);
          return { ok: true, written: true, meta: metaOf(file) };
        } catch {
          return { ok: false, code: 'disk', message: 'The safety copy could not be written to disk.' };
        }
      });
    },
  };
}
