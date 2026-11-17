import type { AppSettings } from '../../types';
import { loadLearnHistory, thresholdBoost } from './learn';
import type { PipelineArgs } from './pipeline';
import { DEFAULT_SMALLEST_LOG_MINUTES } from './significance';

// The "which work is worth a log" settings, in the shape the pipeline takes. The boost per project comes from what the user
// deleted before (see learn.ts), read fresh at every scan.

export type Quality = NonNullable<PipelineArgs['quality']>;

/** A usable smallest log: a whole number from 1 to 240 minutes, else the default. */
export function validSmallestLog(v: unknown): number {
  const n = typeof v === 'number' ? Math.round(v) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 240 ? n : DEFAULT_SMALLEST_LOG_MINUTES;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function qualityFromSettings(
  s: Pick<AppSettings, 'activitySmallestLog' | 'activityDetail'>,
  storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): Quality {
  return {
    smallestLogMinutes: validSmallestLog(s.activitySmallestLog),
    detail: s.activityDetail ?? 'normal',
    boostFor: (projectId) => (storage ? thresholdBoost(loadLearnHistory(storage), projectId) : 1),
  };
}
