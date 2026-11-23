import { describe, it, expect, beforeAll } from 'vitest';
import type { BacklogTask, Project, WorkLog } from '../types';
import { defaultProject } from './projects';
import { buildSnapshot, snapshotSignature, mergeInbox, applyPhoneClockOuts, type InboxItem } from './phoneSync';

describe('applyPhoneClockOuts', () => {
  const IN = '2026-11-11T03:00:00.000Z';
  const item = { id: 'po-1', date: '2026-11-11', clockIn: IN, clockOut: '2026-11-11T11:00:00.000Z' };

  it('closes the same open day', () => {
    const r = applyPhoneClockOuts({ '2026-11-11': { clockIn: IN } }, [item]);
    expect(r.workdays['2026-11-11']).toEqual({ clockIn: IN, clockOut: item.clockOut });
    expect(r.applied).toEqual([item]);
    expect(r.handledIds).toEqual(['po-1']);
  });

  it('the first clock-out wins: a closed day keeps its time, but the item is still handled', () => {
    const days = { '2026-11-11': { clockIn: IN, clockOut: '2026-11-11T10:00:00.000Z' } };
    const r = applyPhoneClockOuts(days, [item]);
    expect(r.workdays).toBe(days);
    expect(r.applied).toEqual([]);
    expect(r.handledIds).toEqual(['po-1']);
  });

  it('skips a day with another clock-in, a missing day and a clock-out before the clock-in', () => {
    const days = { '2026-11-11': { clockIn: '2026-11-11T04:00:00.000Z' } };
    expect(applyPhoneClockOuts(days, [item]).workdays).toBe(days);
    expect(applyPhoneClockOuts({}, [item]).applied).toEqual([]);
    expect(applyPhoneClockOuts({ '2026-11-11': { clockIn: IN } }, [{ ...item, clockOut: '2026-11-11T02:00:00.000Z' }]).applied).toEqual([]);
  });
});

beforeAll(() => {
  process.env.TZ = 'Asia/Dhaka';
});

const TODAY = '2026-11-11';
const projects: Project[] = [
  { id: 'proj-1700000000001', name: 'Alpha', color: '#111111', isArchived: false },
  { id: 'proj-1700000000002', name: 'Beta', color: '#222222', isArchived: false },
  { id: 'proj-1700000000003', name: 'Old', color: '#333333', isArchived: true },
];

const task = (over: Partial<BacklogTask>): BacklogTask => ({
  id: 'task-1700000000000-a',
  title: 'A task',
  projectId: projects[0].id,
  dueDate: TODAY,
  completed: false,
  stage: 'planned',
  originalDate: TODAY,
  isRolledOver: false,
  ...over,
});

const log = (over: Partial<WorkLog>): WorkLog => ({
  id: 'log-1700000000000-a',
  date: TODAY,
  time: '10:00',
  projectId: projects[0].id,
  projectName: 'Alpha',
  description: 'Did a thing',
  status: 'completed',
  tags: [],
  durationMinutes: 30,
  createdAt: '2026-11-11T04:00:00.000Z',
  ...over,
});

const base = {
  backlog: [] as BacklogTask[],
  logs: [] as WorkLog[],
  projects,
  workdays: {},
  tz: 'Asia/Dhaka',
  deviceId: 'dev-abc',
  today: TODAY,
};

// Noon local (06:00 UTC) on a given local date.
const doneOn = (date: string) => `${date}T06:00:00.000Z`;

describe('buildSnapshot', () => {
  it('keeps pending tasks of any date and tasks done within 7 days, drops older done and sample tasks', () => {
    const snap = buildSnapshot({
      ...base,
      backlog: [
        task({ id: 'task-1700000000000-late', dueDate: '2026-11-10' }),
        task({ id: 'task-1700000000000-d3', stage: 'done', completed: true, completedAt: doneOn('2026-11-08') }),
        task({ id: 'task-1700000000000-d10', stage: 'done', completed: true, completedAt: doneOn('2026-11-01') }),
        task({ id: 'task-1' }),
      ],
    });
    expect(snap.tasks.map((t) => t.id)).toEqual(['task-1700000000000-late', 'task-1700000000000-d3']);
    expect(snap.tasks[0].project).toBe('Alpha');
    expect(snap.tasks[1].completedAt).toBe(doneOn('2026-11-08'));
    expect(snap.tasks[0].fromPhone).toBe(false);
  });

  it('does not send the sample projects', () => {
    const snap = buildSnapshot({
      ...base,
      projects: [{ id: 'proj-1', name: 'Core Platform & API', color: '#10b981', isArchived: false }, ...projects],
    });
    expect(snap.projects.map((p) => p.id)).toEqual([projects[0].id, projects[1].id]);
  });

  it('floors tracked seconds to whole minutes', () => {
    const snap = buildSnapshot({ ...base, backlog: [task({ elapsedSeconds: 119 })] });
    expect(snap.tasks[0].trackedMinutes).toBe(1);
  });

  it('includes logs from the last 14 days only and drops sample logs', () => {
    const snap = buildSnapshot({
      ...base,
      logs: [
        log({ id: 'log-1700000000000-old', date: '2026-10-27' }), // 15 days ago
        log({ id: 'log-1700000000000-edge', date: '2026-10-29' }), // 13 days ago
        log({ id: 'log-1700000000000-today' }),
        log({ id: 'log-1' }),
      ],
    });
    expect(snap.logs.map((l) => l.id)).toEqual(['log-1700000000000-edge', 'log-1700000000000-today']);
    expect(snap.logs[1]).toMatchObject({ project: 'Alpha', projectId: projects[0].id, minutes: 30, status: 'completed' });
  });

  it('keeps only the last 14 days of workdays', () => {
    const snap = buildSnapshot({
      ...base,
      workdays: {
        '2026-10-20': { clockIn: '2026-10-20T03:00:00.000Z' },
        '2026-11-11': { clockIn: '2026-11-11T03:00:00.000Z' },
      },
    });
    expect(Object.keys(snap.workdays)).toEqual(['2026-11-11']);
  });

  it('omits archived projects and defaults the workday to 8 hours', () => {
    const snap = buildSnapshot(base);
    expect(snap.projects.map((p) => p.id)).toEqual([projects[0].id, projects[1].id]);
    expect(snap.workdayHours).toBe(8);
    expect(buildSnapshot({ ...base, workdayHours: 6 }).workdayHours).toBe(6);
    expect(snap).toMatchObject({ tz: 'Asia/Dhaka', deviceId: 'dev-abc', today: TODAY });
  });
});

describe('snapshotSignature', () => {
  const snapOf = (t: Partial<BacklogTask>, tz = 'Asia/Dhaka', deviceId = 'dev-abc') =>
    buildSnapshot({ ...base, backlog: [task(t)], tz, deviceId });

  it('ignores tracked minutes, tz and device id', () => {
    const a = snapshotSignature(snapOf({ elapsedSeconds: 60 }));
    expect(snapshotSignature(snapOf({ elapsedSeconds: 600 }, 'UTC', 'dev-other'))).toBe(a);
  });

  it('changes when a title or stage changes', () => {
    const a = snapshotSignature(snapOf({}));
    expect(snapshotSignature(snapOf({ title: 'Renamed' }))).not.toBe(a);
    expect(snapshotSignature(snapOf({ stage: 'in_progress' }))).not.toBe(a);
  });
});

describe('mergeInbox', () => {
  const item = (over: Partial<InboxItem>): InboxItem => ({
    id: 'phone-1',
    title: 'Call the client',
    projectId: projects[1].id,
    projectName: 'Beta',
    dueDate: '2026-11-12',
    createdAt: '2026-11-11T08:00:00.000Z',
    ...over,
  });

  it('turns new items into planned phone tasks', () => {
    const r = mergeInbox([], projects, [item({ id: 'phone-1' }), item({ id: 'phone-2', title: '  Pay invoice ' })], TODAY);
    expect(r.added).toHaveLength(2);
    expect(r.backlog).toHaveLength(2);
    expect(r.added[1]).toMatchObject({
      id: 'phone-2',
      title: 'Pay invoice',
      projectId: projects[1].id,
      dueDate: '2026-11-12',
      originalDate: '2026-11-12',
      stage: 'planned',
      completed: false,
      isRolledOver: false,
      elapsedSeconds: 0,
      isRunning: false,
      fromPhone: true,
    });
    expect(r.takenIds).toEqual(['phone-1', 'phone-2']);
  });

  it('adds nothing for an id already present but still reports it as taken', () => {
    const existing = task({ id: 'phone-1' });
    const r = mergeInbox([existing], projects, [item({ id: 'phone-1' })], TODAY);
    expect(r.added).toEqual([]);
    expect(r.backlog).toEqual([existing]);
    expect(r.takenIds).toEqual(['phone-1']);
  });

  it('falls back to the same-named project, then the first active one', () => {
    const byName = mergeInbox([], projects, [item({ projectId: 'proj-gone', projectName: 'Beta' })], TODAY);
    expect(byName.added[0].projectId).toBe(projects[1].id);
    const first = mergeInbox([], projects, [item({ projectId: 'proj-gone', projectName: 'Nope' })], TODAY);
    expect(first.added[0].projectId).toBe(projects[0].id);
    const archived = mergeInbox([], projects, [item({ projectId: projects[2].id, projectName: 'Old' })], TODAY);
    expect(archived.added[0].projectId).toBe(projects[0].id);
  });

  it('uses the same default project as Plan your day when every project is archived', () => {
    const allArchived = projects.map((p) => ({ ...p, isArchived: true }));
    const r = mergeInbox([], allArchived, [item({ projectId: 'proj-gone', projectName: 'Nope' })], TODAY);
    expect(r.added[0].projectId).toBe(defaultProject(allArchived)!.id);
    expect(r.added[0].projectId).toBe(allArchived[0].id);
  });

  it('skips blank titles but still lists them as taken', () => {
    const r = mergeInbox([], projects, [item({ id: 'phone-3', title: '   ' })], TODAY);
    expect(r.added).toEqual([]);
    expect(r.takenIds).toEqual(['phone-3']);
  });

  it('adds a repeated id in one batch only once', () => {
    const r = mergeInbox([], projects, [item({ id: 'phone-4' }), item({ id: 'phone-4' })], TODAY);
    expect(r.added).toHaveLength(1);
  });

  it('does not mutate its inputs', () => {
    const backlog = [task({})];
    const before = JSON.stringify(backlog);
    const r = mergeInbox(backlog, projects, [item({})], TODAY);
    expect(JSON.stringify(backlog)).toBe(before);
    expect(r.backlog).not.toBe(backlog);
  });
});
