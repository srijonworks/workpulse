import { WorkLog, BacklogTask, Project, AppSettings, BackupData, Workdays, StandupRecord } from '../types';
import { localDateStr } from './dates';
import { moveRunningToDay } from './taskDates';
import { isWorkdays, validWorkdayHours } from './workday';
import { ensureOpenSegment } from './segments';
import { normalizeTheme } from './theme';
import { getInitialSeedData, DEFAULT_SETTINGS } from '../data/seedData';
import { createEngine, readMeta, type Engine, type KV, type SaveResult as EngineSaveResult } from './persist/engine';

const KEYS = {
  LOGS: 'workpulse_logs',
  BACKLOG: 'workpulse_backlog',
  PROJECTS: 'workpulse_projects',
  TAGS: 'workpulse_tags',
  SETTINGS: 'workpulse_settings',
  WORKDAYS: 'workpulse_workdays',
  STANDUPS: 'workpulse_standups',
  SCHEMA_VERSION: 'workpulse_schema_version',
};

export const CURRENT_SCHEMA_VERSION = 1;

/** How the data keys are named to the user ("Your tasks could not be read"). */
export const KEY_LABELS: Record<string, string> = {
  [KEYS.LOGS]: 'work logs',
  [KEYS.BACKLOG]: 'tasks',
  [KEYS.PROJECTS]: 'projects',
  [KEYS.TAGS]: 'tags',
  [KEYS.SETTINGS]: 'settings',
  [KEYS.WORKDAYS]: 'office clock records',
  [KEYS.STANDUPS]: 'saved standups',
};

// A failed save keeps the value and is retried (see ./persist/engine); `kind` says why in the cases it knows.
export type SaveResult = EngineSaveResult;

// The browser's storage, looked up at every call (the tests swap globalThis.localStorage).
const browserKV: KV = {
  getItem: (k) => globalThis.localStorage.getItem(k),
  setItem: (k, v) => globalThis.localStorage.setItem(k, v),
  removeItem: (k) => globalThis.localStorage.removeItem(k),
};

let engine: Engine = createEngine({ kv: browserKV });

/** Every write of the app's data goes through this engine; the screen reads its status ("Not saved", a blocked key). */
export const getEngine = (): Engine => engine;

/** For tests: forget everything the engine was holding. */
export function resetStorageEngine(): Engine {
  engine = createEngine({ kv: browserKV });
  return engine;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isObjectArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((i) => isObj(i) && typeof i.id === 'string');

export const isLogArray = (v: unknown): v is WorkLog[] => isObjectArray(v);
export const isBacklogArray = (v: unknown): v is BacklogTask[] => isObjectArray(v);
export const isProjectArray = (v: unknown): v is Project[] => isObjectArray(v);
export const isStandupArray = (v: unknown): v is StandupRecord[] => isObjectArray(v);
export const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((i) => typeof i === 'string');
export const isSettingsObject = (v: unknown): v is Partial<AppSettings> => isObj(v);

// Reads one key. Absent -> absentFallback (first run). Unreadable, wrong shape, or missing although it was saved
// before -> the raw value is copied to "<key>_corrupt_<timestamp>" so nothing is lost, a warning is recorded,
// corruptFallback is returned (never demo data), and the engine BLOCKS the key: nothing is written to it until
// the user restores it or chooses to start it empty, so the empty fallback can never replace real data.
function readKey<T>(
  key: string,
  guard: (v: unknown) => v is T,
  absentFallback: T,
  corruptFallback: T,
  warnings: string[],
  known: ReadonlySet<string>,
): T {
  let raw: string | null;
  try {
    raw = browserKV.getItem(key);
  } catch {
    warnings.push(`Could not read "${key}" from browser storage.`);
    engine.block(key);
    return corruptFallback;
  }
  if (raw === null) {
    if (known.has(key)) {
      // Saved before and gone now: something removed it. Demo data must not stand in for it.
      warnings.push(`"${key}" is missing from this browser's storage. WorkPulse is not changing it until you restore your data.`);
      engine.block(key);
      return corruptFallback;
    }
    return absentFallback;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (guard(parsed)) return parsed;
  } catch {
    // fall through to quarantine
  }
  engine.block(key);
  const backupKey = `${key}_corrupt_${Date.now()}`;
  try {
    browserKV.setItem(backupKey, raw);
    warnings.push(`"${key}" was unreadable. A copy was kept as "${backupKey}"; the app started with an empty list.`);
  } catch {
    warnings.push(`"${key}" was unreadable and could not be backed up (storage full).`);
  }
  return corruptFallback;
}

// Hook for future schema changes (B1, B2, U2 ...). Runs once when the stored version is older.
function runMigrations(_storedVersion: number): void {
  // No migrations yet: version 1 is the current shape.
}

// Normalises tasks (stage, completed, elapsed time, running state) and gives running clocks an open
// segment. It never changes a task's dueDate: pending tasks stay under their own day.
export function rollOverTasks(
  backlog: BacklogTask[],
  nowIso: string = new Date().toISOString(),
): { tasks: BacklogTask[]; changed: boolean } {
  let changed = false;
  const tasks = backlog.map((task) => {
    // `stage` and `completed` can disagree in old, imported or hand-edited data. Either one saying
    // "done" wins, then `completed` is derived from the stage so they always agree afterwards (C3).
    const isDone = task.stage === 'done' || task.completed === true;
    const normalizedStage = isDone ? 'done' : task.stage || 'planned';

    let next: BacklogTask = {
      ...task,
      stage: normalizedStage,
      completed: isDone,
      elapsedSeconds: task.elapsedSeconds ?? 0,
      isRunning: normalizedStage === 'in_progress',
    };
    // A clock that ran before segments existed gets an open one, so the overs strip can show it.
    if (next.isRunning) {
      const withSegment = ensureOpenSegment(next, nowIso);
      if (withSegment !== next) changed = true;
      next = withSegment;
    }
    return next;
  });
  return { tasks, changed };
}

export function loadStoredData() {
  const seed = getInitialSeedData();
  const warnings: string[] = [];

  // The identity record says which keys have been saved here before, so a key that has vanished is noticed.
  const meta = readMeta(browserKV);
  if (meta) engine.adopt(meta);
  const known = new Set(meta?.keys ?? []);

  const logs = readKey<WorkLog[]>(KEYS.LOGS, isLogArray, seed.logs, [], warnings, known);
  let backlog = readKey<BacklogTask[]>(KEYS.BACKLOG, isBacklogArray, seed.backlog, [], warnings, known);
  const projects = readKey<Project[]>(KEYS.PROJECTS, isProjectArray, seed.projects, [], warnings, known);
  const tags = readKey<string[]>(KEYS.TAGS, isStringArray, seed.tags, [], warnings, known);
  const storedSettings = readKey<Partial<AppSettings> | null>(
    KEYS.SETTINGS,
    (v): v is Partial<AppSettings> | null => isSettingsObject(v),
    null,
    null,
    warnings,
    known,
  );
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...(storedSettings || {}) };
  // Old theme ids (modern, compact, minimalist, matrix) load as their v2 theme.
  const settings: AppSettings = {
    ...merged,
    theme: normalizeTheme(merged.theme),
    workdayHours: validWorkdayHours(merged.workdayHours),
  };
  const workdays = readKey<Workdays>(KEYS.WORKDAYS, isWorkdays, {}, {}, warnings, known);
  const standups = readKey<StandupRecord[]>(KEYS.STANDUPS, isStandupArray, [], [], warnings, known);

  // Normalise tasks (pending ones keep their own day). A timer left running across midnight while the
  // app was closed belongs to today: it moves here, since the live midnight check never saw the change.
  const rolled = rollOverTasks(backlog);
  const withRunningToday = moveRunningToDay(rolled.tasks, localDateStr());
  backlog = withRunningToday;
  const updatedBacklog = rolled.changed || withRunningToday !== rolled.tasks;

  if (updatedBacklog) engine.save(KEYS.BACKLOG, backlog);
  try {
    const storedVersion = Number(browserKV.getItem(KEYS.SCHEMA_VERSION) || 0);
    if (storedVersion < CURRENT_SCHEMA_VERSION) {
      runMigrations(storedVersion);
      browserKV.setItem(KEYS.SCHEMA_VERSION, String(CURRENT_SCHEMA_VERSION));
    }
  } catch (e) {
    console.error('Failed to write storage metadata:', e);
  }

  return { logs, backlog, projects, tags, settings, workdays, standups, warnings };
}

// Every save goes through the engine: a failure keeps the value and it is retried, and the result says why.
const saveKey = (key: string, value: unknown): SaveResult => engine.save(key, value);

export const saveLogs = (logs: WorkLog[]) => saveKey(KEYS.LOGS, logs);
export const saveBacklog = (backlog: BacklogTask[]) => saveKey(KEYS.BACKLOG, backlog);
export const saveProjects = (projects: Project[]) => saveKey(KEYS.PROJECTS, projects);
export const saveTags = (tags: string[]) => saveKey(KEYS.TAGS, tags);
export const saveSettings = (settings: AppSettings) => saveKey(KEYS.SETTINGS, settings);
export const saveWorkdays = (workdays: Workdays) => saveKey(KEYS.WORKDAYS, workdays);
export const saveStandups = (standups: StandupRecord[]) => saveKey(KEYS.STANDUPS, standups);

// Replaces all data keys at once (backup import). Workdays and standups are written only when the backup has
// them; an older backup leaves the stored ones alone. If any write fails, every key is
// restored to its previous value so a failed import cannot leave a half-written state, and nothing
// is kept for later (the caller tells the user the import failed). An import is the user's own
// decision to replace everything, so keys that were blocked as unreadable are let go first, and
// blocked again if the import fails.
export function replaceAllData(d: BackupData): SaveResult {
  const entries: [string, unknown][] = [
    [KEYS.LOGS, d.logs],
    [KEYS.BACKLOG, d.backlog],
    [KEYS.PROJECTS, d.projects],
    [KEYS.TAGS, d.tags],
    [KEYS.SETTINGS, d.settings],
  ];
  if (d.workdays !== undefined) entries.push([KEYS.WORKDAYS, d.workdays]);
  if (d.standups !== undefined) entries.push([KEYS.STANDUPS, d.standups]);
  const wasBlocked = entries.map(([k]) => k).filter((k) => engine.status().blockedKeys.includes(k));
  for (const k of wasBlocked) engine.unblock(k, { discardPending: true });
  const result = engine.trySave(entries);
  if (!result.ok) for (const k of wasBlocked) engine.block(k);
  return result;
}
