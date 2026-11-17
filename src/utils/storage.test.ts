import { describe, it, expect } from 'vitest';
import { addDays, localDateStr } from './dates';
import { loadStoredData, saveLogs, saveTags, saveWorkdays, saveStandups, rollOverTasks, replaceAllData, getEngine, CURRENT_SCHEMA_VERSION } from './storage';

const log = (id: string) => ({
  id,
  date: '2026-01-01',
  time: '10:00',
  projectId: 'p1',
  projectName: 'P',
  description: 'd',
  status: 'completed',
  tags: [],
  createdAt: '2026-01-01T10:00:00.000Z',
});
const task = (id: string) => ({
  id,
  title: 't',
  projectId: 'p1',
  dueDate: '2999-01-01',
  completed: false,
  stage: 'planned',
  originalDate: '2026-01-01',
  isRolledOver: false,
});

const corruptKeys = (prefix: string) =>
  Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) as string).filter((k) =>
    k.startsWith(prefix),
  );

describe('loadStoredData', () => {
  it('corrupt tags key does not affect logs or backlog', () => {
    localStorage.setItem('workpulse_logs', JSON.stringify([log('a')]));
    localStorage.setItem('workpulse_backlog', JSON.stringify([task('t1')]));
    localStorage.setItem('workpulse_tags', '{bad');
    const before = localStorage.getItem('workpulse_logs');

    const r = loadStoredData();

    expect(r.logs.map((l) => l.id)).toEqual(['a']);
    expect(r.backlog.map((t) => t.id)).toEqual(['t1']);
    expect(r.tags).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(corruptKeys('workpulse_tags_corrupt_')).toHaveLength(1);
    expect(localStorage.getItem(corruptKeys('workpulse_tags_corrupt_')[0])).toBe('{bad');
    expect(localStorage.getItem('workpulse_logs')).toBe(before);
  });

  it('keeps the optional phone and email settings and fromPhone on tasks; old data without them loads', () => {
    localStorage.setItem('workpulse_backlog', JSON.stringify([{ ...task('ph'), fromPhone: true }, task('old')]));
    localStorage.setItem(
      'workpulse_settings',
      JSON.stringify({ phoneToken: 'tok', phoneDeviceId: 'dev-abcdefghijkl', emailEnabled: true, emailTime: '18:30' }),
    );
    const r = loadStoredData();
    expect(r.backlog.find((t) => t.id === 'ph')?.fromPhone).toBe(true);
    expect(r.backlog.find((t) => t.id === 'old')?.fromPhone).toBeUndefined();
    expect(r.settings.phoneToken).toBe('tok');
    expect(r.settings.phoneDeviceId).toBe('dev-abcdefghijkl');
    expect(r.settings.emailEnabled).toBe(true);
    expect(r.settings.emailTime).toBe('18:30');

    localStorage.setItem('workpulse_settings', JSON.stringify({}));
    const old = loadStoredData();
    expect(old.settings.phoneToken).toBeUndefined();
    expect(old.settings.emailEnabled).toBeUndefined();
  });

  it('a timer left running across midnight loads under today and is saved; a paused task keeps its date', () => {
    const yesterday = addDays(localDateStr(), -1);
    const open = [{ start: '2026-11-08T01:00:00.000Z' }];
    localStorage.setItem(
      'workpulse_backlog',
      JSON.stringify([
        { ...task('run'), dueDate: yesterday, stage: 'in_progress', isRunning: true, segments: open },
        { ...task('paused'), dueDate: yesterday, stage: 'paused' },
      ]),
    );
    const r = loadStoredData();
    expect(r.backlog.find((t) => t.id === 'run')?.dueDate).toBe(localDateStr());
    expect(r.backlog.find((t) => t.id === 'paused')?.dueDate).toBe(yesterday);
    const saved = JSON.parse(localStorage.getItem('workpulse_backlog') as string);
    expect(saved.find((t: { id: string }) => t.id === 'run').dueDate).toBe(localDateStr());
  });

  it('valid JSON of the wrong type is treated as corrupt, without throwing', () => {
    localStorage.setItem('workpulse_logs', 'null');
    localStorage.setItem('workpulse_backlog', '{}');
    const r = loadStoredData();
    expect(r.logs).toEqual([]);
    expect(r.backlog).toEqual([]);
    expect(r.warnings).toHaveLength(2);
  });

  it('first run (no keys) returns seed data and no warnings', () => {
    const r = loadStoredData();
    expect(r.logs.length).toBeGreaterThan(0);
    expect(r.warnings).toEqual([]);
  });

  it('a corrupt key is never replaced by seed data', () => {
    localStorage.setItem('workpulse_backlog', '{bad');
    expect(loadStoredData().backlog).toEqual([]);
  });

  it('standups: old data without the key loads as [] with no warning, and a save round-trips', () => {
    localStorage.setItem('workpulse_logs', JSON.stringify([log('a')]));
    const r = loadStoredData();
    expect(r.standups).toEqual([]);
    expect(r.warnings).toEqual([]);
    const s = [{ id: 'day:2026-11-10', kind: 'day' as const, from: '2026-11-10', to: '2026-11-10', text: 't', writer: 'template' as const, createdAt: 'c' }];
    expect(saveStandups(s).ok).toBe(true);
    expect(loadStoredData().standups).toEqual(s);
  });

  it('workdays: absent key gives an empty object and no warning', () => {
    const r = loadStoredData();
    expect(r.workdays).toEqual({});
    expect(r.warnings).toEqual([]);
  });

  it('workdays: a stored valid object round-trips through saveWorkdays', () => {
    const w = { '2026-11-10': { clockIn: '2026-11-10T03:48:00.000Z', clockOut: '2026-11-10T11:00:00.000Z' } };
    expect(saveWorkdays(w).ok).toBe(true);
    expect(loadStoredData().workdays).toEqual(w);
  });

  it('workdays: garbage is quarantined with a warning and does not touch other keys', () => {
    localStorage.setItem('workpulse_logs', JSON.stringify([log('a')]));
    localStorage.setItem('workpulse_workdays', '{bad');
    const r = loadStoredData();
    expect(r.workdays).toEqual({});
    expect(r.logs.map((l) => l.id)).toEqual(['a']);
    expect(r.warnings).toHaveLength(1);
    const keys = corruptKeys('workpulse_workdays_corrupt_');
    expect(keys).toHaveLength(1);
    expect(localStorage.getItem(keys[0])).toBe('{bad');
  });

  it('workdays: valid JSON of the wrong shape is quarantined too', () => {
    localStorage.setItem('workpulse_workdays', JSON.stringify({ '2026-11-10': { clockIn: 7 } }));
    expect(loadStoredData().workdays).toEqual({});
    expect(corruptKeys('workpulse_workdays_corrupt_')).toHaveLength(1);
  });

  it('maps a stored legacy theme to its v2 theme', () => {
    localStorage.setItem('workpulse_settings', JSON.stringify({ theme: 'matrix' }));
    expect(loadStoredData().settings.theme).toBe('console');
    localStorage.setItem('workpulse_settings', JSON.stringify({ theme: 'minimalist' }));
    expect(loadStoredData().settings.theme).toBe('timecard');
  });

  it('a stored workdayHours outside 1-16 or not a number loads as undefined', () => {
    for (const bad of [0, 17, -3, 'x', null, 1e999]) {
      localStorage.setItem('workpulse_settings', JSON.stringify({ workdayHours: bad }));
      expect(loadStoredData().settings.workdayHours).toBeUndefined();
    }
    localStorage.setItem('workpulse_settings', JSON.stringify({ workdayHours: 7.5 }));
    expect(loadStoredData().settings.workdayHours).toBe(7.5);
  });

  it('writes the schema version', () => {
    loadStoredData();
    expect(localStorage.getItem('workpulse_schema_version')).toBe(String(CURRENT_SCHEMA_VERSION));
  });
});

describe('save*', () => {
  it('returns ok:false when setItem throws', () => {
    (globalThis as any).localStorage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    expect(saveLogs([]).ok).toBe(false);
  });
  it('returns ok:true on success', () => {
    expect(saveLogs([]).ok).toBe(true);
  });
});

describe('a failed save is kept, not lost', () => {
  const breakWrites = (times = Infinity) => {
    const ls = (globalThis as any).localStorage;
    const real = ls.setItem.bind(ls);
    let left = times;
    ls.setItem = (k: string, v: string) => {
      if (left-- > 0) throw new DOMException('full', 'QuotaExceededError');
      real(k, v);
    };
    return () => {
      ls.setItem = real;
    };
  };

  it('keeps the value, says it is not saved, and writes it when storage works again', () => {
    const fix = breakWrites();
    const r = saveLogs([log('kept') as any]);
    expect(r).toMatchObject({ ok: false, kind: 'quota' });
    expect(getEngine().status()).toMatchObject({ notSaved: true, dirtyKeys: ['workpulse_logs'] });
    expect(localStorage.getItem('workpulse_logs')).toBeNull();
    fix();
    expect(getEngine().retry().ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('workpulse_logs') as string)[0].id).toBe('kept');
    expect(getEngine().status().notSaved).toBe(false);
  });

  it('a later save of the same key replaces the waiting one, so the newest data wins', () => {
    const fix = breakWrites();
    saveLogs([log('old') as any]);
    saveLogs([log('old') as any, log('newer') as any]);
    fix();
    getEngine().retry();
    expect(JSON.parse(localStorage.getItem('workpulse_logs') as string).map((l: { id: string }) => l.id)).toEqual(['old', 'newer']);
  });
});

describe('a key that could not be read is never written over', () => {
  it('blocks a corrupt key: the empty fallback cannot replace the damaged data, and other keys still save', () => {
    localStorage.setItem('workpulse_tags', '{bad');
    loadStoredData();
    expect(getEngine().status().blockedKeys).toEqual(['workpulse_tags']);
    expect(saveTags(['mine'])).toMatchObject({ ok: false, kind: 'blocked' });
    expect(localStorage.getItem('workpulse_tags')).toBe('{bad');
    expect(saveLogs([log('fine') as any]).ok).toBe(true);
    expect(localStorage.getItem('workpulse_tags')).toBe('{bad'); // still, after another key saved
  });

  it('blocks a key that cannot be read at all (storage throws on read)', () => {
    const ls = (globalThis as any).localStorage;
    ls.setItem('workpulse_logs', JSON.stringify([log('a')]));
    const realGet = ls.getItem.bind(ls);
    ls.getItem = (k: string) => {
      if (k === 'workpulse_logs') throw new DOMException('denied', 'SecurityError');
      return realGet(k);
    };
    const r = loadStoredData();
    expect(r.logs).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/Could not read "workpulse_logs"/);
    expect(getEngine().status().blockedKeys).toContain('workpulse_logs');
    ls.getItem = realGet;
    expect(saveLogs([]).ok).toBe(false);
    expect(JSON.parse(localStorage.getItem('workpulse_logs') as string)[0].id).toBe('a'); // the real data is still there
  });

  it('notices a key that was saved before and is gone, and does not put demo data in its place', () => {
    saveLogs([log('mine') as any]);
    localStorage.removeItem('workpulse_logs');
    const r = loadStoredData();
    expect(r.logs).toEqual([]); // not the seed logs
    expect(r.warnings.join(' ')).toMatch(/"workpulse_logs" is missing/);
    expect(getEngine().status().blockedKeys).toContain('workpulse_logs');
  });

  it('does not mistake a first run for a loss', () => {
    const r = loadStoredData();
    expect(r.logs.length).toBeGreaterThan(0);
    expect(getEngine().status().blockedKeys).toEqual([]);
  });

  it('a backup import replaces damaged data: the key is let go, written, and no longer blocked', () => {
    localStorage.setItem('workpulse_logs', '{bad');
    loadStoredData();
    expect(getEngine().status().blockedKeys).toContain('workpulse_logs');
    const r = replaceAllData({ logs: [log('imported') as any], backlog: [], projects: [], tags: [], settings: {} as any });
    expect(r.ok).toBe(true);
    expect(JSON.parse(localStorage.getItem('workpulse_logs') as string)[0].id).toBe('imported');
    expect(getEngine().status().blockedKeys).toEqual([]);
  });

  it('a failed import puts everything back, keeps nothing for later, and blocks the damaged key again', () => {
    localStorage.setItem('workpulse_logs', '{bad');
    loadStoredData();
    saveTags(['before']);
    const before = JSON.stringify(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) as string).sort().map((k) => [k, localStorage.getItem(k)]));
    const ls = (globalThis as any).localStorage;
    const real = ls.setItem.bind(ls);
    ls.setItem = (k: string, v: string) => {
      if (k === 'workpulse_projects') throw new DOMException('full', 'QuotaExceededError');
      real(k, v);
    };
    const r = replaceAllData({ logs: [log('x') as any], backlog: [], projects: [], tags: ['after'], settings: {} as any });
    ls.setItem = real;
    expect(r.ok).toBe(false);
    const after = JSON.stringify(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) as string).sort().map((k) => [k, localStorage.getItem(k)]));
    expect(after).toBe(before);
    expect(getEngine().status().dirtyKeys).toEqual([]);
    expect(getEngine().status().blockedKeys).toContain('workpulse_logs');
  });

  it('remembers the identity of this browser profile across a load', () => {
    saveLogs([]);
    const id = getEngine().status().profileId;
    const after = (globalThis as any).localStorage;
    expect(JSON.parse(after.getItem('workpulse_meta')).profileId).toBe(id);
    getEngine();
    loadStoredData();
    expect(getEngine().status().profileId).toBe(id);
  });
});

describe('rollOverTasks (C3)', () => {
  const base = { id: 't', title: 'T', projectId: 'p', dueDate: '2999-01-01', originalDate: '2026-01-01', isRolledOver: false } as any;
  it('completed:true with a stale stage becomes stage done', () => {
    const { tasks } = rollOverTasks([{ ...base, completed: true, stage: 'in_progress' }]);
    expect(tasks[0]).toMatchObject({ stage: 'done', completed: true, isRunning: false });
  });
  it('stage done with completed:false becomes completed', () => {
    const { tasks } = rollOverTasks([{ ...base, completed: false, stage: 'done' }]);
    expect(tasks[0]).toMatchObject({ stage: 'done', completed: true });
  });
  it('a task with no stage gets one from completed', () => {
    expect(rollOverTasks([{ ...base, completed: false }]).tasks[0]).toMatchObject({ stage: 'planned', completed: false });
  });
  it('never changes dueDate: a planned task due yesterday stays there and is not a change', () => {
    const { tasks, changed } = rollOverTasks([{ ...base, dueDate: '2026-11-09', completed: false, stage: 'planned' }]);
    expect(tasks[0].dueDate).toBe('2026-11-09');
    expect(changed).toBe(false);
  });
  it('a task already marked rolled over keeps its current date', () => {
    const { tasks } = rollOverTasks(
      [{ ...base, dueDate: '2026-11-10', isRolledOver: true, originalDate: '2026-11-08', completed: false, stage: 'planned' }],
    );
    expect(tasks[0].dueDate).toBe('2026-11-10');
  });
  it('a running task due on an earlier day keeps that date but still gets an open segment', () => {
    const { tasks, changed } = rollOverTasks(
      [{ ...base, dueDate: '2026-11-01', completed: false, stage: 'in_progress' }],
      '2026-11-08T05:00:00.000Z',
    );
    expect(changed).toBe(true);
    expect(tasks[0]).toMatchObject({ dueDate: '2026-11-01', isRunning: true });
  });
  it('a running task with no open segment gets one starting now, and that counts as changed', () => {
    const now = '2026-11-08T05:00:00.000Z';
    const { tasks, changed } = rollOverTasks([{ ...base, completed: false, stage: 'in_progress' }], now);
    expect(changed).toBe(true);
    expect(tasks[0].segments).toEqual([{ start: now }]);
  });
  it('a running task that already has an open segment is left alone and is not a change', () => {
    const segments = [{ start: '2026-11-08T01:00:00.000Z' }];
    const { tasks, changed } = rollOverTasks(
      [{ ...base, completed: false, stage: 'in_progress', segments }],
      '2026-11-08T05:00:00.000Z',
    );
    expect(changed).toBe(false);
    expect(tasks[0].segments).toEqual(segments);
  });
  it('tasks that are not running get no segment', () => {
    const { tasks, changed } = rollOverTasks([{ ...base, completed: false, stage: 'paused' }]);
    expect(changed).toBe(false);
    expect(tasks[0].segments).toBeUndefined();
  });
});
