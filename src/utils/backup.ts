import { BackupData, AppSettings } from '../types';
import { DEFAULT_SETTINGS } from '../data/seedData';
import { CURRENT_SCHEMA_VERSION, isStandupArray, isLogArray, isBacklogArray, isProjectArray, isStringArray, isSettingsObject } from './storage';
import { isWorkdays, validWorkdayHours } from './workday';

// JSON backup text. The Gemini API key is never written to a backup file (S4), and neither is
// lastBackupAt (and the Sheet copy's date and error): that date belongs to this device, not to the data. The same goes for the phone token,
// last phone sync, device id and last phone error. The email settings and the project folder links are kept
// (an import only uses the folder links when this computer has none: see keepDeviceSettings).
export function backupSettings(all: AppSettings): Omit<AppSettings, DeviceOnlySetting> {
  const {
    geminiApiKey: _omit,
    lastBackupAt: _omitBackup,
    phoneToken: _omitToken,
    phoneSyncAt: _omitSyncAt,
    phoneDeviceId: _omitDevice,
    phoneLastError: _omitError,
    sheetBackupAt: _omitSheetAt,
    sheetBackupError: _omitSheetError,
    widgets: _omitWidgets,
    ...settings
  } = all;
  return settings;
}

type DeviceOnlySetting =
  | 'geminiApiKey'
  | 'lastBackupAt'
  | 'phoneToken'
  | 'phoneSyncAt'
  | 'phoneDeviceId'
  | 'phoneLastError'
  | 'sheetBackupAt'
  | 'sheetBackupError'
  | 'widgets';

// The backup file's text. `indent` 0 gives the compact form used for the copy in the Sheet.
export function buildBackup(d: BackupData, indent = 2): string {
  return JSON.stringify(
    {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      logs: d.logs,
      backlog: d.backlog,
      projects: d.projects,
      tags: d.tags,
      settings: backupSettings(d.settings),
      workdays: d.workdays ?? {},
      standups: d.standups ?? [],
    },
    null,
    indent,
  );
}

// Folder links from a backup: only well-formed ones that point at a project in the same backup.
function validFolders(v: unknown, projects: { id: string }[]): AppSettings['activityFolders'] {
  if (!Array.isArray(v)) return undefined;
  const ids = new Set(projects.map((p) => p.id));
  const out = v.filter(
    (f): f is { path: string; projectId: string } =>
      !!f && typeof f === 'object' && typeof f.path === 'string' && f.path.length > 0 && f.path.length < 500 && typeof f.projectId === 'string' && ids.has(f.projectId),
  );
  return out.length > 0 ? out : undefined;
}

export type ParseBackupResult = { ok: true; data: BackupData } | { ok: false; error: string };

// Validates a backup file. Imported settings never carry an API key (the caller keeps the current one).
export function parseBackup(text: string): ParseBackupResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'This file is not a WorkPulse backup.' };
  }
  const o = parsed as Record<string, unknown>;
  if (!isLogArray(o.logs)) return { ok: false, error: 'Backup is missing a valid "logs" list.' };
  if (!isBacklogArray(o.backlog)) return { ok: false, error: 'Backup is missing a valid "backlog" list.' };
  if (!isProjectArray(o.projects)) return { ok: false, error: 'Backup is missing a valid "projects" list.' };
  if (!isStringArray(o.tags)) return { ok: false, error: 'Backup is missing a valid "tags" list.' };
  if (o.settings !== undefined && !isSettingsObject(o.settings)) {
    return { ok: false, error: 'Backup has invalid "settings".' };
  }
  if (o.workdays !== undefined && !isWorkdays(o.workdays)) {
    return { ok: false, error: 'Backup has invalid "workdays".' };
  }
  if (o.standups !== undefined && !isStandupArray(o.standups)) {
    return { ok: false, error: 'Backup has invalid "standups".' };
  }
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...((o.settings as object) || {}),
    geminiApiKey: '',
    lastBackupAt: undefined,
    activityFolders: validFolders((o.settings as { activityFolders?: unknown } | undefined)?.activityFolders, o.projects),
    phoneToken: undefined,
    phoneSyncAt: undefined,
    phoneDeviceId: undefined,
    phoneLastError: undefined,
    sheetBackupAt: undefined,
    sheetBackupError: undefined,
    widgets: undefined,
  };
  settings.workdayHours = validWorkdayHours(settings.workdayHours);
  return {
    ok: true,
    data: { logs: o.logs, backlog: o.backlog, projects: o.projects, tags: o.tags, settings, workdays: o.workdays, standups: o.standups },
  };
}

export function downloadTextFile(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
