import type { BackupData, BacklogTask } from '../types';
import { backupSettings, buildBackup } from './backup';
import { isSampleLog, isSampleProject, isSampleTask } from '../data/sampleData';
import { isRunningTask } from './timerStore';

// The pure part of the automatic full copy to the Sheet (no window, React or localStorage).

export const BACKUP_DEBOUNCE_MS = 30_000;
export const RUNNING_BACKUP_MS = 10 * 60_000;
export const LOAD_BACKUP_AFTER_MS = 60 * 60_000;
export const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
/** The first script version that can keep a backup. */
export const BACKUP_SCRIPT_VERSION = 4;

export interface BackupCounts {
  logs: number;
  tasks: number;
  projects: number;
}

export const backupCounts = (d: BackupData): BackupCounts => ({
  logs: d.logs.length,
  tasks: d.backlog.length,
  projects: d.projects.length,
});

// The backup text for the Sheet: compact, and without the screenshots of logs (they would make it too big).
export function buildSheetBackup(d: BackupData): string {
  return buildBackup({ ...d, logs: d.logs.map((l) => (l.imageBase64 ? { ...l, imageBase64: undefined } : l)) }, 0);
}

/**
 * False for a fresh profile that only holds the demo data. It is never copied by itself: on a new browser
 * it would push out the real copies in the Sheet before they can be restored.
 */
export function hasRealData(d: BackupData): boolean {
  return (
    d.logs.some((l) => !isSampleLog(l)) ||
    d.backlog.some((t) => !isSampleTask(t)) ||
    d.projects.some((p) => !isSampleProject(p)) ||
    Object.keys(d.workdays ?? {}).length > 0
  );
}

const taskForSignature = (t: BacklogTask) => {
  if (!isRunningTask(t)) return t;
  // A running task's seconds and segment ends move all the time; its start and stage are what matter.
  const { elapsedSeconds: _s, segments, ...rest } = t;
  return { ...rest, segmentStarts: segments?.map((s) => s.start) };
};

/**
 * A text that changes when the data to back up changes, and not when only a running timer ticks.
 * Device-only settings (the Sheet copy's own date and error included) are left out, so recording a
 * backup never counts as a change.
 */
export function backupSignature(d: BackupData): string {
  return JSON.stringify([
    d.logs.map((l) => (l.imageBase64 ? { ...l, imageBase64: true } : l)),
    d.backlog.map(taskForSignature),
    d.projects,
    d.tags,
    d.workdays ?? {},
    backupSettings(d.settings),
    ...(d.standups && d.standups.length > 0 ? [d.standups.map((s) => ({ ...s, syncedAt: undefined }))] : []),
  ]);
}

/**
 * Whether to copy to the Sheet now. `baseline` is the signature last copied (or, before the first copy
 * of this session, null). With no baseline the data counts as unchanged since the last copy, so only an
 * old or missing copy (1 hour) is made at load. After a failure wait a few minutes.
 */
export function shouldBackup(i: {
  signature: string;
  baseline: string | null;
  lastBackupAtMs: number | null;
  lastFailureAtMs: number | null;
  nowMs: number;
  running: boolean;
}): boolean {
  if (i.lastFailureAtMs !== null && i.nowMs - i.lastFailureAtMs < RETRY_AFTER_FAILURE_MS) return false;
  if (i.baseline === null) return i.lastBackupAtMs === null || i.nowMs - i.lastBackupAtMs >= LOAD_BACKUP_AFTER_MS;
  if (i.signature !== i.baseline) return true;
  return i.running && i.lastBackupAtMs !== null && i.nowMs - i.lastBackupAtMs >= RUNNING_BACKUP_MS;
}
