import { describe, it, expect } from 'vitest';
import { createScriptHarness, type ScriptHarness } from '../../test/appsScriptHarness';
import { GOOGLE_APPS_SCRIPT_CODE } from '../googleAppsScriptTemplate';

function withToken(h: ScriptHarness): string {
  const r = h.call('setPin', { pin: '1234' });
  expect(r.status).toBe('ok');
  return r.token as string;
}

const COUNTS = { logs: 12, tasks: 3, projects: 2 };
const payload = (n: number, ch = 'a') => JSON.stringify({ logs: [], note: ch.repeat(n) });
const rowsOf = (h: ScriptHarness) => h.sheets.WorkPulse_Backup.slice(1).filter((r) => r.some((v) => v !== '' && v !== undefined));

describe('script v4: sheet backup', () => {
  it('needs the desktop token for all three actions', () => {
    const h = createScriptHarness();
    withToken(h);
    for (const [action, extra] of [['saveBackup', { backup: '{}', meta: { counts: COUNTS } }], ['backupInfo', {}], ['loadBackup', {}]] as const) {
      expect(h.call(action, { ...extra })).toMatchObject({ status: 'error', code: 'bad_token' });
      expect(h.call(action, { ...extra, token: 'nope' })).toMatchObject({ status: 'error', code: 'bad_token' });
    }
    expect(h.sheets.WorkPulse_Backup).toBeUndefined();
  });

  it('splits a 500 KB backup into chunks of at most 40,000 characters and puts it back together', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    const text = payload(500_000, 'é😀x'); // multi-byte text too
    const r = h.call('saveBackup', { token, backup: text, meta: { counts: COUNTS, exportedAt: 'x' } });
    expect(r).toMatchObject({ status: 'ok', version: 1 });
    expect(h.sheets.WorkPulse_Backup[0]).toEqual(['Version', 'Chunk', 'Total', 'Data', 'SavedAt', 'Counts']);
    const rows = rowsOf(h);
    const total = Math.ceil(text.length / 40_000);
    expect(rows).toHaveLength(total);
    for (const row of rows) {
      expect(String(row[3]).length).toBeLessThanOrEqual(40_000);
      expect(String(row[2])).toBe(String(total));
    }
    expect(String(rows[0][3]).length).toBe(40_000);
    const loaded = h.call('loadBackup', { token });
    expect(loaded.status).toBe('ok');
    expect(loaded.backup).toBe(text);
    expect(loaded.savedAt).toBe(r.savedAt);
  });

  it('keeps one chunk for a backup exactly at the boundary and two just above it', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    h.call('saveBackup', { token, backup: 'x'.repeat(40_000), meta: { counts: COUNTS } });
    expect(rowsOf(h)).toHaveLength(1);
    h.call('saveBackup', { token, backup: 'y'.repeat(40_001), meta: { counts: COUNTS } });
    expect(rowsOf(h).filter((r) => String(r[0]) === '2')).toHaveLength(2);
    expect(h.call('loadBackup', { token }).backup).toBe('y'.repeat(40_001));
  });

  it('stores the cells as plain text, so numbers and dates in the JSON stay exactly as sent', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    // A backup that is, as text, just a number or a date: Sheets would turn it into one without the text format.
    h.call('saveBackup', { token, backup: '2026-11-11', meta: { counts: COUNTS } });
    expect(rowsOf(h)[0].slice(0, 4)).toEqual(['1', '0', '1', '2026-11-11']);
    expect(h.call('loadBackup', { token }).backup).toBe('2026-11-11');
    h.call('saveBackup', { token, backup: '12345', meta: { counts: COUNTS } });
    expect(h.call('loadBackup', { token }).backup).toBe('12345');
  });

  it('keeps only the latest 3 versions and lists them newest first with their counts', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    for (let i = 1; i <= 5; i++) {
      h.call('saveBackup', { token, backup: payload(90_000, String(i)), meta: { counts: { logs: i, tasks: 0, projects: 1 } } });
    }
    const info = h.call('backupInfo', { token });
    expect(info.status).toBe('ok');
    expect(info.versions.map((v: any) => v.version)).toEqual([5, 4, 3]);
    expect(info.versions[0].counts).toEqual({ logs: 5, tasks: 0, projects: 1 });
    expect([...new Set(rowsOf(h).map((r) => String(r[0])))]).toEqual(['3', '4', '5']);
    expect(h.call('loadBackup', { token, version: 4 }).backup).toBe(payload(90_000, '4'));
    expect(h.call('loadBackup', { token, version: 1 })).toMatchObject({ status: 'error', code: 'bad_request' });
    expect(h.call('loadBackup', { token }).backup).toBe(payload(90_000, '5'));
  });

  it('says so when there is no backup yet', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    expect(h.call('backupInfo', { token })).toEqual({ status: 'ok', versions: [] });
    const r = h.call('loadBackup', { token });
    expect(r).toMatchObject({ status: 'error', code: 'bad_request' });
    expect(r.message).toBe('There is no backup in the Sheet yet.');
  });

  it('a reader never sees a copy that is still being written, and the next save cleans it up', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    h.call('saveBackup', { token, backup: payload(100_000, 'a'), meta: { counts: COUNTS } });
    // A save that died after writing rows for version 2 but before listing it.
    const sheet = h.sheets.WorkPulse_Backup;
    sheet.push(['2', '0', '3', 'half', 'x', ''], ['2', '1', '3', 'written', 'x', '']);
    expect(h.call('backupInfo', { token }).versions.map((v: any) => v.version)).toEqual([1]);
    expect(h.call('loadBackup', { token }).backup).toBe(payload(100_000, 'a'));
    expect(h.call('loadBackup', { token, version: 2 })).toMatchObject({ status: 'error' });
    const r = h.call('saveBackup', { token, backup: payload(50_000, 'b'), meta: { counts: COUNTS } });
    expect(r.version).toBe(2);
    expect(h.call('loadBackup', { token }).backup).toBe(payload(50_000, 'b'));
    expect(rowsOf(h).some((row) => row[3] === 'half')).toBe(false);
  });

  it('a failed save leaves the previous copy readable', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    h.call('saveBackup', { token, backup: payload(100_000, 'a'), meta: { counts: COUNTS } });
    // The write of the new rows fails half way (more rows than the fake sheet's setValues accepts is not
    // needed: make the property update fail instead, after the rows are written).
    const real = h.props.backupVersions;
    Object.defineProperty(h.props, 'backupVersions', {
      configurable: true,
      get: () => real,
      set: () => {
        throw new Error('Service error');
      },
    });
    const r = h.call('saveBackup', { token, backup: payload(60_000, 'c'), meta: { counts: COUNTS } });
    expect(r.status).toBe('error');
    expect(h.lockHeld).toBe(false);
    expect(h.call('loadBackup', { token }).backup).toBe(payload(100_000, 'a'));
  });

  it('loadBackup of an incomplete copy is a plain error', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    h.call('saveBackup', { token, backup: payload(100_000, 'a'), meta: { counts: COUNTS } });
    h.sheets.WorkPulse_Backup.splice(2, 1); // lose chunk 1
    const r = h.call('loadBackup', { token, version: 1 });
    expect(r).toMatchObject({ status: 'error', code: 'bad_request' });
    expect(r.message).toContain('incomplete');
    h.sheets.WorkPulse_Backup.length = 1; // lose everything
    expect(h.call('loadBackup', { token })).toMatchObject({ status: 'error', message: expect.stringContaining('incomplete') });
  });

  it('refuses a backup above 20 MB with a plain message, and an empty or missing one', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    const big = h.call('saveBackup', { token, backup: 'z'.repeat(20 * 1024 * 1024 + 1), meta: { counts: COUNTS } });
    expect(big).toMatchObject({ status: 'error', code: 'bad_request' });
    expect(big.message).toContain('20 MB');
    expect(h.call('saveBackup', { token, backup: '', meta: {} })).toMatchObject({ status: 'error', code: 'bad_request' });
    expect(h.call('saveBackup', { token, meta: {} })).toMatchObject({ status: 'error', code: 'bad_request' });
    expect(h.props.backupVersions).toBeUndefined();
  });

  it('does not add public functions and stays ES5 style', () => {
    const names = [...GOOGLE_APPS_SCRIPT_CODE.matchAll(/^function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
    for (const n of ['saveBackupAction_', 'backupInfoAction_', 'loadBackupAction_', 'pruneBackupRows_', 'backupList_']) {
      expect(names).toContain(n);
    }
    expect(names.filter((n) => /backup/i.test(n) && !n.endsWith('_'))).toEqual([]);
    expect(GOOGLE_APPS_SCRIPT_CODE).not.toMatch(/\b(let|const)\s/);
    expect(GOOGLE_APPS_SCRIPT_CODE).not.toMatch(/=>/);
    expect(GOOGLE_APPS_SCRIPT_CODE).not.toContain('`');
  });

  it('keeps the version 3 phone actions working', () => {
    const h = createScriptHarness();
    const token = withToken(h);
    expect(h.get({ action: 'ping' })).toMatchObject({ version: 8 });
    expect(h.call('pullInbox', { token })).toEqual({ status: 'ok', items: [] });
  });
});
