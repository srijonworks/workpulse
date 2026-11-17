import { localDateStr } from './dates';
import type { EngineStatus } from './persist/engine';
import { STORAGE_LIMIT_BYTES, storageNearlyFull } from './persist/engine';
import type { MirrorState } from './persist/diskMirror';
import { severityOf, THRESHOLDS, type HealthEntry } from './health/registry';
import type { Journal } from './jobs/journal';

// System status: turns what the app already knows (the save engine, the disk copy, the health registry, the repairs
// note, the day-close journal, the storage use) into one row per subsystem, in plain words. Pure. A row never carries
// raw error text, a path, an address or anything the user wrote: only fixed sentences, states and times.

export type StatusState = 'ok' | 'warn' | 'bad';
export type StatusAction = 'retry' | 'open-settings' | 'download-backup';

export interface StatusRow {
  id: 'saving' | 'disk' | 'sheet' | 'phone' | 'activity' | 'autoDay' | 'screens' | 'desktop';
  label: string;
  state: StatusState;
  /** A fixed, plain sentence. */
  sentence: string;
  /** The last time it worked (ms), when known. */
  lastOkAt?: number;
  action?: StatusAction;
}

/** One entry of the repairs note kept by the data doctor (localStorage `workpulse_repairs`). */
export interface StoredRepair {
  at: string;
  kind: string;
  message: string;
}

export interface SystemStatusInput {
  now: number;
  engine: EngineStatus;
  disk: MirrorState;
  health: HealthEntry[];
  repairs: StoredRepair[];
  journal: Journal;
  storageBytes: number;
  sheetConfigured: boolean;
  phoneConfigured: boolean;
  autoDayEnabled: boolean;
  /** Running inside the desktop app (the bridge is there). */
  desktop: boolean;
}

export interface DayCloseDay {
  date: string;
  /** 'done': logs were added; 'empty': nothing to add; 'waiting': no record (not closed yet, or no clock-out). */
  state: 'done' | 'empty' | 'waiting';
  added: number;
}

export interface SystemStatus {
  rows: StatusRow[];
  repairs: { at: string; message: string }[];
  dayClose: DayCloseDay[];
  storage: { bytes: number; limitBytes: number; percent: number; nearlyFull: boolean };
  /** The worst state of any row. */
  overall: StatusState;
}

const RANK: Record<StatusState, number> = { ok: 0, warn: 1, bad: 2 };
const worst = (a: StatusState, b: StatusState): StatusState => (RANK[a] >= RANK[b] ? a : b);

const MINUTE = 60_000;

const byId = (health: HealthEntry[], id: string): HealthEntry | undefined => health.find((e) => e.id === id);

function healthState(e: HealthEntry | undefined, now: number): StatusState {
  if (!e) return 'ok';
  const s = severityOf(e, now);
  return s === 'critical' ? 'bad' : s === 'warning' ? 'warn' : 'ok';
}

const latest = (...xs: (number | undefined)[]): number | undefined => {
  const n = xs.filter((x): x is number => typeof x === 'number');
  return n.length ? Math.max(...n) : undefined;
};

/** The worst of several registry entries, with the sentence of the entry that is failing and the newest success. */
function fromHealth(
  entries: (HealthEntry | undefined)[],
  now: number,
  fallbackOk: string,
): { state: StatusState; sentence: string; lastOkAt?: number; action?: StatusAction } {
  let state: StatusState = 'ok';
  let sentence = fallbackOk;
  let action: StatusAction | undefined;
  for (const e of entries) {
    const s = healthState(e, now);
    if (s !== 'ok' && RANK[s] > RANK[state]) {
      state = s;
      sentence = e?.message || 'Something is not working.';
      action = e?.action ? 'open-settings' : e?.retryable ? 'retry' : undefined;
    }
  }
  return { state, sentence, lastOkAt: latest(...entries.map((e) => e?.lastOkAt)), action };
}

function savingRow(i: SystemStatusInput): StatusRow {
  const e = i.engine;
  const base = { id: 'saving' as const, label: 'Saving', lastOkAt: e.lastOkAt };
  if (e.blockedKeys.length > 0) {
    return { ...base, state: 'bad', sentence: 'Part of your data could not be read, so WorkPulse is not changing it. Download a backup and check the disk copy.', action: 'download-backup' };
  }
  if (e.notSaved) {
    if (e.lastErrorKind === 'quota') {
      return { ...base, state: 'bad', sentence: 'This browser has no room left. Recent changes are held in memory. Download a backup now.', action: 'download-backup' };
    }
    if (e.lastErrorKind === 'frozen' || e.frozen) {
      return { ...base, state: 'warn', sentence: 'This window is read-only because WorkPulse is open in another window.' };
    }
    return { ...base, state: 'bad', sentence: 'Recent changes are not saved yet. WorkPulse keeps trying.', action: 'retry' };
  }
  if (e.frozen) return { ...base, state: 'warn', sentence: 'This window is read-only because WorkPulse is open in another window.' };
  if (storageNearlyFull(i.storageBytes)) {
    return { ...base, state: 'warn', sentence: 'Browser storage is nearly full. Download a backup and remove old screenshots.', action: 'download-backup' };
  }
  const h = fromHealth([byId(i.health, 'storage')], i.now, 'Every change is saved.');
  if (h.state !== 'ok') return { ...base, state: h.state, sentence: h.sentence, action: h.action };
  return { ...base, state: 'ok', sentence: 'Every change is saved.' };
}

function diskRow(i: SystemStatusInput): StatusRow {
  const d = i.disk;
  const base = { id: 'disk' as const, label: 'Disk copy' };
  const server = fromHealth([byId(i.health, 'server')], i.now, '');
  if (server.state !== 'ok') {
    return { ...base, state: server.state, sentence: 'WorkPulse could not reach its own server, so the disk copy is not being made.', action: 'retry' };
  }
  switch (d.kind) {
    case 'ok':
      return { ...base, state: 'ok', sentence: 'A copy of your data is kept on this computer.', lastOkAt: d.at };
    case 'idle':
      return { ...base, state: 'ok', sentence: 'The first copy is made a few seconds after start-up.' };
    case 'conflict':
      return { ...base, state: 'warn', sentence: 'The copy on disk belongs to another browser profile, so nothing is copied until you choose.', action: 'open-settings' };
    case 'failing': {
      const lasted = i.now - d.since;
      const state: StatusState = lasted >= (THRESHOLDS.diskCopy?.warnAfterMs ?? 30 * MINUTE) ? 'warn' : 'ok';
      return {
        ...base,
        state,
        sentence: state === 'ok' ? 'The last disk copy did not work. WorkPulse is trying again.' : 'The disk copy has not worked for a while.',
        lastOkAt: byId(i.health, 'diskCopy')?.lastOkAt,
        action: 'retry',
      };
    }
    case 'paused':
      return { ...base, state: d.why === 'the copy on disk is newer' ? 'warn' : 'ok', sentence: `Paused: ${d.why}.` };
  }
}

function sheetRow(i: SystemStatusInput): StatusRow {
  const base = { id: 'sheet' as const, label: 'Google Sheet sync' };
  if (!i.sheetConfigured) return { ...base, state: 'ok', sentence: 'Not set up. It is optional.' };
  const h = fromHealth([byId(i.health, 'sheetSync'), byId(i.health, 'sheetBackup')], i.now, 'The Sheet is up to date.');
  return { ...base, ...h };
}

function phoneRow(i: SystemStatusInput): StatusRow {
  const base = { id: 'phone' as const, label: 'Phone and evening email' };
  const entries = [byId(i.health, 'phone'), byId(i.health, 'email')];
  if (!i.phoneConfigured && entries.every((e) => !e)) return { ...base, state: 'ok', sentence: 'Not set up. It is optional.' };
  const h = fromHealth(entries, i.now, 'The phone sync is working.');
  return { ...base, ...h };
}

function activityRow(i: SystemStatusInput): StatusRow {
  const e = byId(i.health, 'activity');
  const h = fromHealth([e], i.now, e?.lastOkAt ? 'The activity readers are working.' : 'No check yet.');
  return { id: 'activity', label: 'Activity readers', ...h };
}

function autoDayRow(i: SystemStatusInput): StatusRow {
  const base = { id: 'autoDay' as const, label: 'Automatic day' };
  const dates = Object.keys(i.journal).sort();
  const lastAt = dates.length ? Date.parse(i.journal[dates[dates.length - 1]].at) : NaN;
  const lastOkAt = Number.isFinite(lastAt) ? lastAt : undefined;
  if (!i.autoDayEnabled) return { ...base, state: 'ok', sentence: 'Switched off in Settings.', lastOkAt };
  const h = fromHealth([byId(i.health, 'dayClose')], i.now, 'Finished days are closed out on their own.');
  return { ...base, ...h, lastOkAt: latest(h.lastOkAt, lastOkAt) };
}

function screensRow(i: SystemStatusInput): StatusRow {
  const h = fromHealth([byId(i.health, 'app')], i.now, 'No screen has crashed in this session.');
  return { id: 'screens', label: 'Screens', state: h.state, sentence: h.sentence, action: h.state === 'ok' ? undefined : 'retry' };
}

function desktopRow(i: SystemStatusInput): StatusRow {
  const base = { id: 'desktop' as const, label: 'Desktop app' };
  if (!i.desktop) return { ...base, state: 'ok', sentence: 'Running in a browser, not the desktop app.' };
  const h = fromHealth([byId(i.health, 'desktop')], i.now, 'The desktop app is running and keeps itself saved.');
  return { ...base, ...h };
}

/** The last seven local days, newest first, with what the day-close journal says about each. */
export function dayCloseDays(journal: Journal, nowMs: number, n = 7): DayCloseDay[] {
  const out: DayCloseDay[] = [];
  for (let k = 0; k < n; k++) {
    const date = localDateStr(new Date(nowMs - k * 24 * 3600 * 1000));
    const e = journal[date];
    out.push(e ? { date, state: e.state, added: e.added } : { date, state: 'waiting', added: 0 });
  }
  return out;
}

export function buildSystemStatus(i: SystemStatusInput): SystemStatus {
  const rows = [savingRow(i), diskRow(i), sheetRow(i), phoneRow(i), activityRow(i), autoDayRow(i), screensRow(i), desktopRow(i)];
  const bytes = Math.max(0, i.storageBytes);
  return {
    rows,
    repairs: i.repairs.slice(-10).reverse().map((r) => ({ at: r.at, message: r.message })),
    dayClose: dayCloseDays(i.journal, i.now),
    storage: { bytes, limitBytes: STORAGE_LIMIT_BYTES, percent: Math.min(100, Math.round((bytes / STORAGE_LIMIT_BYTES) * 100)), nearlyFull: storageNearlyFull(bytes) },
    overall: rows.reduce<StatusState>((acc, r) => worst(acc, r.state), 'ok'),
  };
}

/** Reads the repairs note. Never throws; anything unreadable is an empty list. */
export function parseRepairs(text: string | null): StoredRepair[] {
  try {
    const v = JSON.parse(text ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((r): r is StoredRepair => !!r && typeof r === 'object' && typeof (r as StoredRepair).message === 'string')
      .map((r) => ({ at: typeof r.at === 'string' ? r.at : '', kind: typeof r.kind === 'string' ? r.kind : '', message: r.message }));
  } catch {
    return [];
  }
}

/** Text for a bug report: counts and states only. No log text, no names, no addresses, no keys. */
export function buildDiagnostics(s: SystemStatus, nowMs: number): string {
  const lines = [`WorkPulse diagnostics, ${new Date(nowMs).toISOString()}`, `Overall: ${s.overall}`];
  for (const r of s.rows) lines.push(`${r.label}: ${r.state}${r.lastOkAt ? `, last worked ${new Date(r.lastOkAt).toISOString()}` : ''}`);
  lines.push(`Repairs kept: ${s.repairs.length}`);
  const done = s.dayClose.filter((d) => d.state === 'done').length;
  const empty = s.dayClose.filter((d) => d.state === 'empty').length;
  lines.push(`Last ${s.dayClose.length} days: ${done} closed with logs, ${empty} closed empty, ${s.dayClose.length - done - empty} waiting`);
  lines.push(`Storage: ${s.storage.percent}% of ${Math.round(s.storage.limitBytes / 1024 / 1024)} MB`);
  return lines.join('\n');
}
