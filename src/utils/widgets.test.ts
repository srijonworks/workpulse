import { describe, it, expect } from 'vitest';
import type { BacklogTask, Project } from '../types';
import type { WorkLog } from '../types';
import { buildWidgetSnapshot, isSnapshotStale, parseWidgetTask, snapshotSignature, STALE_AFTER_MS, widgetConfig } from './widgets';

process.env.TZ = 'Asia/Dhaka';

const TODAY = '2026-11-15';
const task = (o: Partial<BacklogTask> = {}): BacklogTask => ({
  id: 't', title: 'T', projectId: 'p1', dueDate: TODAY, completed: false, stage: 'planned',
  originalDate: TODAY, isRolledOver: false, elapsedSeconds: 0, ...o,
});
const projects: Project[] = [
  { id: 'p1', name: 'Alpha', color: '#2e86de', isArchived: false },
  { id: 'p2', name: 'Gone', color: '#d6455d', isArchived: false, trashedAt: '2026-11-01T00:00:00.000Z' },
];
const build = (backlog: BacklogTask[], extra: Partial<Parameters<typeof buildWidgetSnapshot>[0]> = {}) =>
  buildWidgetSnapshot({ theme: 'chase', backlog, projects, workdays: {}, workdayHours: undefined, today: TODAY, nowMs: 1000, ...extra });

describe('widgetConfig', () => {
  it('is off by default and on top once on', () => {
    expect(widgetConfig(undefined)).toEqual({ time: { on: false, top: true }, tasks: { on: false, top: true } });
    expect(widgetConfig({ tasks: { on: true, top: false } }).tasks).toEqual({ on: true, top: false });
  });
});

describe('buildWidgetSnapshot', () => {
  it('lists running first, then paused, blocked and planned; skips done and upcoming', () => {
    const snap = build([
      task({ id: 'a', stage: 'planned' }),
      task({ id: 'b', stage: 'blocked' }),
      task({ id: 'c', stage: 'paused', isRunning: false, dueDate: '2026-11-10' }),
      task({ id: 'd', stage: 'in_progress', isRunning: true }),
      task({ id: 'e', stage: 'done', completed: true }),
      task({ id: 'f', stage: 'planned', dueDate: '2026-11-20' }),
      task({ id: 'g', stage: 'planned', dueDate: '2026-11-10' }),
    ]);
    expect(snap.tasks.map((t) => t.id)).toEqual(['d', 'c', 'b', 'a', 'g']);
    expect(snap.tasks.map((t) => t.state)).toEqual(['running', 'paused', 'blocked', 'planned', 'planned']);
  });
  it('hides a trashed project and defaults the workday to 8 hours with no clock-in', () => {
    const snap = build([task({ projectId: 'p2' })]);
    expect(snap.tasks[0].project).toBe('');
    expect(snap.hours).toBe(8);
    expect(snap.clockIn).toBeNull();
  });
  it('uses the open workday record', () => {
    const snap = build([], { workdays: { [TODAY]: { clockIn: '2026-11-15T03:00:00.000Z' } }, workdayHours: 6 });
    expect(snap.clockIn).toBe('2026-11-15T03:00:00.000Z');
    expect(snap.hours).toBe(6);
  });
});

describe('snapshotSignature', () => {
  it('ignores ticking time but not a change of state', () => {
    const run = (s: number) => build([task({ stage: 'in_progress', isRunning: true, elapsedSeconds: s })]);
    expect(snapshotSignature(run(10))).toBe(snapshotSignature(run(11)));
    const paused = build([task({ stage: 'paused', isRunning: false, elapsedSeconds: 10 })]);
    expect(snapshotSignature(paused)).not.toBe(snapshotSignature(run(10)));
  });
});

describe('snapshot day figures', () => {
  const log = (date: string, durationMinutes?: number): WorkLog =>
    ({ id: date + durationMinutes, date, time: '10:00', projectId: 'p1', projectName: 'Alpha', description: 'x', status: 'completed', tags: [], durationMinutes }) as unknown as WorkLog;
  it('sums only today logs and carries the date', () => {
    const snap = build([], { logs: [log(TODAY, 30), log(TODAY, 45), log(TODAY), log('2026-11-14', 60)] });
    expect(snap.loggedMinutes).toBe(75);
    expect(snap.date).toBe(TODAY);
  });
  it('defaults to nothing logged and no problems, and keeps at most three problems', () => {
    const snap = build([]);
    expect(snap.loggedMinutes).toBe(0);
    expect(snap.problems).toEqual([]);
    expect(build([], { problems: ['a', 'b', 'c', 'd'] }).problems).toEqual(['a', 'b', 'c']);
  });
  it('a change of logged time or problems changes the signature', () => {
    const a = snapshotSignature(build([], { logs: [log(TODAY, 30)] }));
    expect(snapshotSignature(build([], { logs: [log(TODAY, 31)] }))).not.toBe(a);
    expect(snapshotSignature(build([], { logs: [log(TODAY, 30)], problems: ['x'] }))).not.toBe(a);
  });
});

describe('isSnapshotStale', () => {
  it('is stale only after 90 seconds', () => {
    const snap = build([], { nowMs: 1000 });
    expect(isSnapshotStale(snap, 1000 + STALE_AFTER_MS)).toBe(false);
    expect(isSnapshotStale(snap, 1000 + STALE_AFTER_MS + 1)).toBe(true);
  });
});

describe('parseWidgetTask', () => {
  it('takes a trailing #project', () => {
    expect(parseWidgetTask('Write report #alp', projects)).toEqual({ title: 'Write report', projectId: 'p1' });
  });
  it('keeps the whole text when the tag matches nothing, and trashed projects do not match', () => {
    expect(parseWidgetTask('Review PR #212', projects)).toEqual({ title: 'Review PR #212' });
    expect(parseWidgetTask('Thing #gone', projects)).toEqual({ title: 'Thing #gone' });
  });
  it('rejects empty text and a lone tag', () => {
    expect(parseWidgetTask('   ', projects)).toBeNull();
    expect(parseWidgetTask('#alpha', projects)).toBeNull();
  });
});
