process.env.TZ = 'Asia/Dhaka';
import { describe, expect, it } from 'vitest';
import { buildDiagnostics, buildSystemStatus, dayCloseDays, parseRepairs, type SystemStatusInput } from './systemStatus';
import type { EngineStatus } from './persist/engine';

const NOW = Date.parse('2026-11-17T10:00:00Z');
const engine = (o: Partial<EngineStatus> = {}): EngineStatus => ({ dirtyKeys: [], blockedKeys: [], frozen: false, notSaved: false, rev: 3, profileId: 'p', ...o });
const input = (o: Partial<SystemStatusInput> = {}): SystemStatusInput => ({
  now: NOW,
  engine: engine({ lastOkAt: NOW - 1000 }),
  disk: { kind: 'ok', at: NOW - 5000, rev: 3 },
  health: [],
  repairs: [],
  journal: {},
  storageBytes: 1000,
  sheetConfigured: false,
  phoneConfigured: false,
  autoDayEnabled: true,
  desktop: false,
  ...o,
});
const row = (s: ReturnType<typeof buildSystemStatus>, id: string) => s.rows.find((r) => r.id === id)!;

describe('buildSystemStatus', () => {
  it('is all ok when nothing is wrong', () => {
    const s = buildSystemStatus(input());
    expect(s.overall).toBe('ok');
    expect(s.rows.map((r) => r.id)).toEqual(['saving', 'disk', 'sheet', 'phone', 'activity', 'ai', 'autoDay', 'screens', 'desktop']);
  });
  it('marks a blocked key bad with a backup action', () => {
    const r = row(buildSystemStatus(input({ engine: engine({ blockedKeys: ['workpulse_logs'] }) })), 'saving');
    expect(r.state).toBe('bad');
    expect(r.action).toBe('download-backup');
  });
  it('marks unsaved changes bad with retry, a full browser with backup, a second window warn', () => {
    expect(row(buildSystemStatus(input({ engine: engine({ notSaved: true, lastErrorKind: 'unavailable' }) })), 'saving').action).toBe('retry');
    expect(row(buildSystemStatus(input({ engine: engine({ notSaved: true, lastErrorKind: 'quota' }) })), 'saving').action).toBe('download-backup');
    expect(row(buildSystemStatus(input({ engine: engine({ frozen: true }) })), 'saving').state).toBe('warn');
  });
  it('warns when storage is nearly full', () => {
    const s = buildSystemStatus(input({ storageBytes: 4.5 * 1024 * 1024 }));
    expect(row(s, 'saving').state).toBe('warn');
    expect(s.storage.nearlyFull).toBe(true);
  });
  it('keeps a short disk copy failure quiet and warns after 30 minutes', () => {
    const quiet = row(buildSystemStatus(input({ disk: { kind: 'failing', message: 'ENOENT C:\secret', since: NOW - 60_000 } })), 'disk');
    expect(quiet.state).toBe('ok');
    const loud = row(buildSystemStatus(input({ disk: { kind: 'failing', message: 'ENOENT C:\secret', since: NOW - 31 * 60_000 } })), 'disk');
    expect(loud.state).toBe('warn');
    expect(JSON.stringify(loud)).not.toContain('secret');
  });
  it('warns on a conflict and on a newer copy', () => {
    expect(row(buildSystemStatus(input({ disk: { kind: 'conflict' } })), 'disk').state).toBe('warn');
    expect(row(buildSystemStatus(input({ disk: { kind: 'paused', why: 'the copy on disk is newer' } })), 'disk').state).toBe('warn');
    expect(row(buildSystemStatus(input({ disk: { kind: 'paused', why: 'nothing to copy yet' } })), 'disk').state).toBe('ok');
  });
  it('uses the registry message, never its detail', () => {
    const s = buildSystemStatus(
      input({
        sheetConfigured: true,
        health: [{ id: 'sheetSync', failingSince: NOW - 3 * 3600_000, count: 5, message: 'The Sheet did not answer.', detail: 'https://script.google.com/macros/s/SECRET', retryable: true }],
      }),
    );
    const r = row(s, 'sheet');
    expect(r.state).toBe('warn');
    expect(r.sentence).toBe('The Sheet did not answer.');
    expect(r.action).toBe('retry');
    expect(JSON.stringify(s)).not.toContain('SECRET');
  });
  it('goes critical to bad and offers open-settings when the entry has an action', () => {
    const r = row(buildSystemStatus(input({ sheetConfigured: true, health: [{ id: 'sheetSync', failingSince: NOW - 25 * 3600_000, count: 9, message: 'Redeploy the script.', action: 'Redeploy' }] })), 'sheet');
    expect(r.state).toBe('bad');
    expect(r.action).toBe('open-settings');
  });
  it('says so when the automatic day is off, and reports a crash on screens', () => {
    expect(row(buildSystemStatus(input({ autoDayEnabled: false })), 'autoDay').sentence).toMatch(/off/i);
    expect(row(buildSystemStatus(input({ health: [{ id: 'app', failingSince: NOW, count: 1, message: 'A part of WorkPulse (the clock) ran into a problem.' }] })), 'screens').state).toBe('warn');
  });
});

describe('dayCloseDays, parseRepairs, buildDiagnostics', () => {
  it('lists seven local days newest first', () => {
    const d = dayCloseDays({ '2026-11-16': { state: 'done', at: '', added: 2 } }, NOW);
    expect(d).toHaveLength(7);
    expect(d[0].date).toBe('2026-11-17');
    expect(d[1]).toEqual({ date: '2026-11-16', state: 'done', added: 2 });
    expect(d[2].state).toBe('waiting');
  });
  it('reads the repairs note defensively', () => {
    expect(parseRepairs('nope')).toEqual([]);
    expect(parseRepairs(null)).toEqual([]);
    expect(parseRepairs('[{"at":"x","kind":"log-id","message":"m"},5]')).toHaveLength(1);
  });
  it('writes diagnostics with counts and states only', () => {
    const s = buildSystemStatus(input({ repairs: [{ at: 'x', kind: 'log-id', message: 'A work log had a missing or repeated id and was given a new one.' }] }));
    const text = buildDiagnostics(s, NOW);
    expect(text).toContain('Overall: ok');
    expect(text).toContain('Repairs kept: 1');
    expect(text).not.toContain('missing or repeated');
    expect(text).toContain('Storage:');
  });
});

describe('AI writer and skipped work', () => {
  it('says the AI writer fell back to plain wording, as a warning', () => {
    const s = buildSystemStatus(input({ aiWriter: { state: 'fallback', sentence: 'The AI writer is not available, so WorkPulse is using plain wording. It tries again by itself.' } }));
    expect(row(s, 'ai').state).toBe('warn');
    expect(row(s, 'ai').sentence).toMatch(/plain wording/);
  });
  it('mentions the small work left out of the logs of today', () => {
    const s = buildSystemStatus(input({ skippedToday: 3 }));
    expect(row(s, 'activity').sentence).toMatch(/3 small pieces of work left out/);
  });
});

