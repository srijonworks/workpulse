import { describe, it, expect } from 'vitest';
import { buildBackup, parseBackup } from './backup';
import { replaceAllData } from './storage';
import { DEFAULT_SETTINGS } from '../data/seedData';
import type { BackupData } from '../types';

const data = (): BackupData => ({
  logs: [{ id: 'l1', date: '2026-01-01', time: '10:00', projectId: 'p', projectName: 'P', description: 'x', status: 'completed', tags: [], createdAt: 'c' }],
  backlog: [],
  projects: [{ id: 'p', name: 'P', color: '#fff', isArchived: false }],
  tags: ['a'],
  settings: { ...DEFAULT_SETTINGS, geminiApiKey: 'SECRET-KEY-123', googleScriptUrl: 'https://script.google.com/macros/s/x/exec' },
});

describe('backup', () => {
  it('buildBackup never contains the API key', () => {
    expect(buildBackup(data())).not.toContain('SECRET-KEY-123');
  });
  it('round trip keeps everything except the key', () => {
    const r = parseBackup(buildBackup(data()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.logs).toEqual(data().logs);
      expect(r.data.projects).toEqual(data().projects);
      expect(r.data.settings.googleScriptUrl).toBe('https://script.google.com/macros/s/x/exec');
      expect(r.data.settings.geminiApiKey).toBe('');
    }
  });
  it('rejects malformed input with an error message', () => {
    for (const bad of ['{bad', '[]', '"x"', '{"logs":null}', JSON.stringify({ logs: [], backlog: [], tags: [] })]) {
      const r = parseBackup(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
    }
  });
  it('the last-backup date stays on the device: never written, never imported', () => {
    const withDate = { ...data(), settings: { ...data().settings, lastBackupAt: '2026-11-01T00:00:00.000Z' } };
    expect(buildBackup(withDate)).not.toContain('lastBackupAt');
    const forged = parseBackup(JSON.stringify({ ...JSON.parse(buildBackup(data())), settings: { lastBackupAt: '2030-01-01T00:00:00.000Z' } }));
    expect(forged.ok && forged.data.settings.lastBackupAt).toBeUndefined();
  });
  it('an imported API key in the file is ignored', () => {
    const r = parseBackup(JSON.stringify({ ...JSON.parse(buildBackup(data())), settings: { geminiApiKey: 'EVIL' } }));
    expect(r.ok && r.data.settings.geminiApiKey).toBe('');
  });
});

describe('workdays in backups', () => {
  const workdays = { '2026-11-10': { clockIn: '2026-11-10T03:48:00.000Z' } };
  it('buildBackup includes workdays and a round trip keeps them', () => {
    const text = buildBackup({ ...data(), workdays });
    expect(JSON.parse(text).workdays).toEqual(workdays);
    const r = parseBackup(text);
    expect(r.ok && r.data.workdays).toEqual(workdays);
  });
  it('a backup file without workdays still imports, with workdays undefined', () => {
    const { workdays: _omit, ...old } = JSON.parse(buildBackup(data()));
    const r = parseBackup(JSON.stringify(old));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.workdays).toBeUndefined();
  });
  it('workdayHours outside 1-16 imports as undefined', () => {
    for (const bad of [0, 40, 'eight']) {
      const r = parseBackup(JSON.stringify({ ...JSON.parse(buildBackup(data())), settings: { workdayHours: bad } }));
      expect(r.ok && r.data.settings.workdayHours).toBeUndefined();
    }
    const ok = parseBackup(JSON.stringify({ ...JSON.parse(buildBackup(data())), settings: { workdayHours: 9 } }));
    expect(ok.ok && ok.data.settings.workdayHours).toBe(9);
  });
  it('rejects workdays whose clock times are not dates', () => {
    const r = parseBackup(JSON.stringify({ ...JSON.parse(buildBackup(data())), workdays: { '2026-11-10': { clockIn: 'nope' } } }));
    expect(r.ok).toBe(false);
  });
  it('rejects invalid workdays', () => {
    const r = parseBackup(JSON.stringify({ ...JSON.parse(buildBackup(data())), workdays: [1] }));
    expect(r.ok).toBe(false);
  });
  it('replaceAllData writes workdays when present and leaves them alone when undefined', () => {
    expect(replaceAllData({ ...data(), workdays }).ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('workpulse_workdays')!)).toEqual(workdays);
    expect(replaceAllData(data()).ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('workpulse_workdays')!)).toEqual(workdays);
  });
});

describe('replaceAllData', () => {
  it('writes all keys', () => {
    expect(replaceAllData(data()).ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('workpulse_tags')!)).toEqual(['a']);
  });
  it('rolls back every key when one write fails', () => {
    localStorage.setItem('workpulse_logs', '["old-logs"]');
    localStorage.setItem('workpulse_tags', '["old-tags"]');
    const real = localStorage.setItem.bind(localStorage);
    (localStorage as any).setItem = (k: string, v: string) => {
      if (k === 'workpulse_tags' && v !== '["old-tags"]') throw new Error('quota');
      real(k, v);
    };
    expect(replaceAllData(data()).ok).toBe(false);
    expect(localStorage.getItem('workpulse_logs')).toBe('["old-logs"]');
    expect(localStorage.getItem('workpulse_tags')).toBe('["old-tags"]');
  });
});

describe('phone settings in backups', () => {
  const phoneSettings = () => ({
    ...data().settings,
    phoneToken: 'TOKEN-SECRET',
    phoneSyncAt: '2026-11-11T10:00:00.000Z',
    phoneDeviceId: 'dev-abcdefghijkl',
    phoneLastError: 'It broke',
    sheetBackupAt: '2026-11-11T12:00:00.000Z',
    sheetBackupError: 'SHEET-ERR',
    widgets: { time: { on: true } },
    emailEnabled: true,
    emailTime: '18:30',
  });
  it('buildBackup omits the four device-only keys but keeps the email settings', () => {
    const text = buildBackup({ ...data(), settings: phoneSettings() });
    for (const k of ['phoneToken', 'phoneSyncAt', 'phoneDeviceId', 'phoneLastError', 'sheetBackupAt', 'sheetBackupError', 'widgets', 'TOKEN-SECRET']) {
      expect(text).not.toContain(k);
    }
    const s = JSON.parse(text).settings;
    expect(s.emailEnabled).toBe(true);
    expect(s.emailTime).toBe('18:30');
  });
  it('parseBackup clears the device-only keys if a file carries them', () => {
    const forged = parseBackup(JSON.stringify({ ...JSON.parse(buildBackup(data())), settings: phoneSettings() }));
    expect(forged.ok).toBe(true);
    if (forged.ok) {
      const s = forged.data.settings;
      expect(s.phoneToken).toBeUndefined();
      expect(s.phoneSyncAt).toBeUndefined();
      expect(s.phoneDeviceId).toBeUndefined();
      expect(s.phoneLastError).toBeUndefined();
      expect(s.sheetBackupAt).toBeUndefined();
      expect(s.sheetBackupError).toBeUndefined();
      expect(s.widgets).toBeUndefined();
      expect(s.emailEnabled).toBe(true);
      expect(s.emailTime).toBe('18:30');
    }
  });
});

describe('project folder links in backups', () => {
  const pid = data().projects[0].id;
  it('are written, and imported only when they point at a project in the same backup', () => {
    const withFolders = { ...data(), settings: { ...data().settings, activityFolders: [{ path: 'E:/work/proj', projectId: pid }, { path: 'E:/x', projectId: 'nope' }] } };
    expect(buildBackup(withFolders)).toContain('E:/work/proj');
    const back = parseBackup(buildBackup(withFolders));
    expect(back.ok && back.data.settings.activityFolders).toEqual([{ path: 'E:/work/proj', projectId: pid }]);
    const junk = parseBackup(JSON.stringify({ ...JSON.parse(buildBackup(data())), settings: { activityFolders: 'x' } }));
    expect(junk.ok && junk.data.settings.activityFolders).toBeUndefined();
  });
});

describe('standups in backups', () => {
  const standups = [{ id: 'day:2026-11-10', kind: 'day' as const, from: '2026-11-10', to: '2026-11-10', text: 'hi', writer: 'claude' as const, createdAt: 'c' }];
  it('round trip keeps standups', () => {
    const r = parseBackup(buildBackup({ ...data(), standups }));
    expect(r.ok && r.data.standups).toEqual(standups);
  });
  it('an old backup without standups imports with undefined and leaves stored ones alone', () => {
    const { standups: _omit, ...old } = JSON.parse(buildBackup(data()));
    const r = parseBackup(JSON.stringify(old));
    expect(r.ok && r.data.standups).toBeUndefined();
    expect(replaceAllData({ ...data(), standups }).ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('workpulse_standups')!)).toEqual(standups);
    expect(replaceAllData({ ...data() }).ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('workpulse_standups')!)).toEqual(standups);
  });
  it('rejects invalid standups', () => {
    const r = parseBackup(JSON.stringify({ ...JSON.parse(buildBackup(data())), standups: 5 }));
    expect(r.ok).toBe(false);
  });
});
