import type { BacklogTask, Project, WorkLog, Workdays } from '../types';
import { localDateOfIso } from './dates';

// The data doctor: fixes damage that would otherwise break screens or sums (a missing or repeated id, a task whose
// seconds are NaN, a log pointing at a project that is gone, a clock-out before its clock-in). It runs at load, and
// after an import or a restore. Rules: it never deletes a record, never changes text, durations or clock-ins that are
// valid, and running it twice changes nothing (it returns the same objects when there is nothing to fix).

export interface DoctorData {
  logs: WorkLog[];
  backlog: BacklogTask[];
  projects: Project[];
  workdays: Workdays;
}

export interface Repair {
  /** A short code, for counting. */
  kind: 'log-id' | 'task-id' | 'log-date' | 'log-minutes' | 'task-seconds' | 'project-missing' | 'clock-out';
  /** One plain sentence for System status. Never includes what the user wrote. */
  message: string;
}

export interface DoctorResult extends DoctorData {
  repairs: Repair[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDER_COLOR = '#94a3b8';

function uniqueIds<T extends { id?: unknown }>(items: T[], kind: 'log-id' | 'task-id', repairs: Repair[], prefix: string): T[] {
  const seen = new Set<string>();
  let changed = false;
  const out = items.map((item) => {
    let id = typeof item.id === 'string' && item.id ? item.id : '';
    if (id && !seen.has(id)) {
      seen.add(id);
      return item;
    }
    let n = 1;
    const base = id || `${prefix}-fixed`;
    do id = `${base}-${n++}`;
    while (seen.has(id));
    seen.add(id);
    changed = true;
    repairs.push({ kind, message: kind === 'log-id' ? 'A work log had a missing or repeated id and was given a new one.' : 'A task had a missing or repeated id and was given a new one.' });
    return { ...item, id };
  });
  return changed ? out : items;
}

export const REPAIRS_KEY = 'workpulse_repairs';

/** Remembers what was repaired (newest 50, device-only, for System status). Never throws. */
export function recordRepairs(repairs: Repair[], kv: Pick<Storage, 'getItem' | 'setItem'> = globalThis.localStorage, at: Date = new Date()): void {
  try {
    const old = JSON.parse(kv.getItem(REPAIRS_KEY) ?? '[]') as unknown;
    const list = Array.isArray(old) ? old : [];
    const next = [...list, ...repairs.map((r) => ({ at: at.toISOString(), ...r }))].slice(-50);
    kv.setItem(REPAIRS_KEY, JSON.stringify(next));
  } catch {
    // a note about a repair must never stop the app
  }
}

export function repairData(data: DoctorData): DoctorResult {
  const repairs: Repair[] = [];

  let logs = uniqueIds(data.logs, 'log-id', repairs, 'log');
  let backlog = uniqueIds(data.backlog, 'task-id', repairs, 'task');

  // Log dates and minutes.
  let logsChanged = false;
  const fixedLogs = logs.map((l) => {
    let next = l;
    if (typeof l.date !== 'string' || !DATE_RE.test(l.date)) {
      const fromCreated = typeof l.createdAt === 'string' && !Number.isNaN(Date.parse(l.createdAt)) ? localDateOfIso(l.createdAt) : null;
      if (fromCreated) {
        next = { ...next, date: fromCreated };
        repairs.push({ kind: 'log-date', message: 'A work log had no valid date and was dated from when it was created.' });
      }
    }
    if (l.durationMinutes !== undefined && (!Number.isFinite(l.durationMinutes) || l.durationMinutes < 0)) {
      const { durationMinutes: _drop, ...rest } = next;
      next = rest as WorkLog;
      repairs.push({ kind: 'log-minutes', message: 'A work log had an impossible duration, which was cleared.' });
    }
    if (next !== l) logsChanged = true;
    return next;
  });
  if (logsChanged) logs = fixedLogs;

  // Task seconds.
  let backlogChanged = false;
  const fixedBacklog = backlog.map((t) => {
    const bad = (v: unknown) => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0);
    if (!bad(t.elapsedSeconds) && !bad(t.loggedSeconds)) return t;
    backlogChanged = true;
    repairs.push({ kind: 'task-seconds', message: 'A task had impossible tracked time, which was reset to zero.' });
    return { ...t, ...(bad(t.elapsedSeconds) ? { elapsedSeconds: 0 } : {}), ...(bad(t.loggedSeconds) ? { loggedSeconds: 0 } : {}) };
  });
  if (backlogChanged) backlog = fixedBacklog;

  // A log or task that points at a project that is gone gets a placeholder project with the same id, so nothing is lost
  // and the picker still works. The name comes from the log when it has one.
  const projectIds = new Set(data.projects.map((p) => p.id));
  const added: Project[] = [];
  const need = (id: unknown, name?: string) => {
    if (typeof id !== 'string' || !id || projectIds.has(id)) return;
    projectIds.add(id);
    added.push({ id, name: name?.trim() || 'Recovered project', color: PLACEHOLDER_COLOR, isArchived: false });
    repairs.push({ kind: 'project-missing', message: 'Work pointed at a project that no longer exists, so a placeholder project was added.' });
  };
  for (const l of logs) need(l.projectId, l.projectName);
  for (const t of backlog) need(t.projectId);
  const projects = added.length > 0 ? [...data.projects, ...added] : data.projects;

  // A clock-out before its clock-in is dropped (the day shows as open, so the user can clock out again).
  let workdays = data.workdays;
  for (const [date, rec] of Object.entries(data.workdays)) {
    if (rec.clockOut !== undefined && Date.parse(rec.clockOut) < Date.parse(rec.clockIn)) {
      if (workdays === data.workdays) workdays = { ...data.workdays };
      const { clockOut: _drop, ...rest } = rec;
      workdays[date] = rest;
      repairs.push({ kind: 'clock-out', message: 'A clock-out was earlier than its clock-in, so it was removed.' });
    }
  }

  return { logs, backlog, projects, workdays, repairs };
}
