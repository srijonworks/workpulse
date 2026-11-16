import { DATA_KEYS, isDataKey, type DataKey } from './keys';

// What a copy of the user's data on disk looks like, shared by the server that writes it and the page that asks for it.

export interface CopyCounts {
  logs: number;
  tasks: number;
  projects: number;
  workdays: number;
}

export interface CopyMeta {
  format: 1;
  /** Which browser profile (see StorageMeta.profileId) the data came from. */
  profileId: string;
  /** The app address it was made at ("localhost:3000", "localhost:38417"): data belongs to an address. */
  origin: string;
  /** The profile's save counter when this was taken. A lower one never replaces a higher one. */
  rev: number;
  savedAt: string;
  counts: CopyCounts;
  /** Of `keys`, checked whenever the copy is read. */
  sha256: string;
}

export interface CopyFile extends CopyMeta {
  /** The raw stored text of each data key, exactly as the browser held it. */
  keys: Partial<Record<DataKey, string>>;
}

const lengthOf = (raw: string | undefined, kind: 'array' | 'object'): number => {
  if (raw === undefined) return 0;
  try {
    const v: unknown = JSON.parse(raw);
    if (kind === 'array') return Array.isArray(v) ? v.length : 0;
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).length : 0;
  } catch {
    return 0;
  }
};

/** How much is in a copy, read from the stored text (an unreadable key counts as 0). */
export function countsOf(keys: Partial<Record<string, string>>): CopyCounts {
  return {
    logs: lengthOf(keys.workpulse_logs, 'array'),
    tasks: lengthOf(keys.workpulse_backlog, 'array'),
    projects: lengthOf(keys.workpulse_projects, 'array'),
    workdays: lengthOf(keys.workpulse_workdays, 'object'),
  };
}

/** The keys in a fixed order, as one text: what the checksum is taken of. */
export function canonicalKeysText(keys: Partial<Record<string, string>>): string {
  return JSON.stringify(DATA_KEYS.filter((k) => typeof keys[k] === 'string').map((k) => [k, keys[k]]));
}

/** Only the data keys, only strings. Returns null when there is nothing usable. */
export function cleanKeys(raw: unknown): Partial<Record<DataKey, string>> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Partial<Record<DataKey, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDataKey(k)) continue;
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}
