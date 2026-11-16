import { isSampleLog, isSampleProject, isSampleTask } from '../../data/sampleData';
import type { CopyMeta } from './copyFormat';
import { DATA_KEYS, type DataKey } from './keys';

// Decides what to do when the page starts and a copy of its data exists on disk. Pure: the caller passes what it
// found, and acts on the answer (the page restores; the server never decides).

export type RawKeys = Partial<Record<string, string | null>>;

export interface LocalState {
  profileId: string;
  rev: number;
  /** The stored text of each data key (null or absent when the key is not there). */
  raw: RawKeys;
  /** Keys the page could not read (see the save engine). */
  blockedKeys: string[];
}

export type Decision =
  | { action: 'none' }
  /** Mirror this browser's data from now on (replacing the copy of an earlier profile, which is kept as a safety copy). */
  | { action: 'take-over' }
  /** Ask the user to bring the copy back: this browser holds nothing real, or an older state than the copy. */
  | { action: 'offer-restore'; reason: 'empty' | 'behind' }
  /** Put these keys back from the copy straight away: they could not be read here. */
  | { action: 'restore-keys'; keys: DataKey[] };

const parse = (text: string | null | undefined): unknown => {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const arrayOf = (text: string | null | undefined): { id?: string }[] => {
  const v = parse(text);
  return Array.isArray(v) ? (v as { id?: string }[]) : [];
};

/** True when the stored data holds something the user made (the demo data does not count). */
export function hasRealStoredData(raw: RawKeys): boolean {
  const wd = parse(raw.workpulse_workdays);
  return (
    arrayOf(raw.workpulse_logs).some((l) => !isSampleLog({ id: String(l.id) })) ||
    arrayOf(raw.workpulse_backlog).some((t) => !isSampleTask({ id: String(t.id) })) ||
    arrayOf(raw.workpulse_projects).some((p) => !isSampleProject({ id: String(p.id) })) ||
    (!!wd && typeof wd === 'object' && !Array.isArray(wd) && Object.keys(wd).length > 0)
  );
}

const copyHasData = (m: CopyMeta): boolean => m.counts.logs + m.counts.tasks + m.counts.projects + m.counts.workdays > 0;

export function decide(local: LocalState, copy: CopyMeta | null, copyKeys?: Partial<Record<DataKey, string>>): Decision {
  if (!copy || !copyHasData(copy)) return { action: 'none' };

  const blocked = DATA_KEYS.filter((k) => local.blockedKeys.includes(k) && typeof copyKeys?.[k] === 'string');
  if (blocked.length > 0) return { action: 'restore-keys', keys: blocked };

  if (!hasRealStoredData(local.raw)) return { action: 'offer-restore', reason: 'empty' };

  if (copy.profileId === local.profileId) {
    return copy.rev > local.rev ? { action: 'offer-restore', reason: 'behind' } : { action: 'none' };
  }
  // A different profile that holds real data: the user has been working here, so this browser's data wins and the old
  // copy is kept as a safety copy.
  return { action: 'take-over' };
}
