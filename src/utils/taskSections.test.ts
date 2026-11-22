import { describe, it, expect } from 'vitest';
import { dayLabelLong, earlierPlans, filterByProject, groupTasks, sectionProjectIds } from './taskSections';
import type { BacklogTask } from '../types';

process.env.TZ = 'Asia/Dhaka';

const today = '2026-11-10';
const task = (id: string, over: Partial<BacklogTask> = {}): BacklogTask => ({
  id,
  title: id,
  projectId: 'p',
  dueDate: today,
  completed: false,
  stage: 'planned',
  originalDate: today,
  isRolledOver: false,
  ...over,
});
const done = (id: string, completedAt: string, over: Partial<BacklogTask> = {}) =>
  task(id, { stage: 'done', completed: true, completedAt, ...over });
const ids = (list: BacklogTask[]) => list.map((t) => t.id);

describe('dayLabelLong', () => {
  it('writes weekday, day and month', () => {
    expect(dayLabelLong('2026-11-09')).toBe('Mon 9 Nov');
    expect(dayLabelLong('2026-12-01')).toBe('Tue 1 Dec');
  });
});

describe('groupTasks', () => {
  it('puts every pending task in one date group whatever its stage', () => {
    const g = groupTasks(
      [
        task('two', { dueDate: '2026-11-08' }),
        task('y1', { dueDate: '2026-11-09' }),
        task('yb', { dueDate: '2026-11-09', stage: 'blocked', blockReason: 'vendor key' }),
        task('fresh'),
        task('pToday', { stage: 'paused' }),
        task('tom', { dueDate: '2026-11-11' }),
        task('wk2', { dueDate: '2026-11-16' }), // today + 6: last day of "this week"
        task('wk1', { dueDate: '2026-11-12', stage: 'paused' }),
        task('far', { dueDate: '2026-11-17' }), // today + 7: later
        task('rolled', { dueDate: '2026-11-10', isRolledOver: true, originalDate: '2026-11-08' }),
      ],
      today,
    );
    // Overdue: newest date first, started before planned within a date.
    expect(ids(g.overdue)).toEqual(['yb', 'y1', 'two']);
    expect(ids(g.today)).toEqual(['pToday', 'fresh', 'rolled']);
    expect(ids(g.tomorrow)).toEqual(['tom']);
    expect(ids(g.thisWeek)).toEqual(['wk1', 'wk2']);
    expect(ids(g.later)).toEqual(['far']);
    expect(g.done).toEqual([]);
  });

  it('keeps a running task under today even when it is due another day, running first', () => {
    const g = groupTasks(
      [
        task('plan'),
        task('paused', { stage: 'paused' }),
        task('run', { stage: 'in_progress', isRunning: true }),
        task('later', { dueDate: '2026-11-12', stage: 'in_progress', isRunning: true }),
        task('old', { dueDate: '2026-11-08', stage: 'in_progress', isRunning: true }),
      ],
      today,
    );
    expect(ids(g.today)).toEqual(['run', 'later', 'old', 'paused', 'plan']);
    expect(g.overdue).toEqual([]);
    expect(g.thisWeek).toEqual([]);
  });

  it('lists done tasks of the last 7 local days, newest first', () => {
    const g = groupTasks(
      [
        done('old', '2026-11-03T10:00:00.000Z'), // 3 Nov 16:00 Dhaka: outside (window starts 4 Nov)
        done('edge', '2026-11-03T18:30:00.000Z'), // 4 Nov 00:30 Dhaka: inside
        done('early', '2026-11-09T20:00:00.000Z'), // 10 Nov 02:00 Dhaka
        done('mid', '2026-11-08T05:00:00.000Z'),
        done('future', '2026-11-12T05:00:00.000Z'), // clock skew: not recent
        task('open'),
      ],
      today,
    );
    expect(ids(g.done)).toEqual(['early', 'mid', 'edge']);
  });

  it('falls back to the due date for a done task with no completion time', () => {
    const g = groupTasks([task('nostamp', { stage: 'done', completed: true, dueDate: '2026-11-09' })], today);
    expect(ids(g.done)).toEqual(['nostamp']);
  });
});

describe('filterByProject and sectionProjectIds', () => {
  const list = [
    task('a', { projectId: 'p1' }),
    task('b', { projectId: 'p2', dueDate: '2026-11-11' }),
    task('c', { projectId: 'p2', stage: 'blocked', dueDate: '2026-11-09' }),
    task('e', { projectId: 'p1', dueDate: '2026-11-09' }),
    task('f', { projectId: 'p2', dueDate: '2026-11-09' }),
    done('d', '2026-11-09T05:00:00.000Z', { projectId: 'p3' }),
  ];

  it('lists the projects that have something on the screen', () => {
    expect(sectionProjectIds(groupTasks(list, today)).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('keeps only one project in every group', () => {
    const f = filterByProject(groupTasks(list, today), 'p2');
    expect(ids(f.today)).toEqual([]);
    expect(ids(f.tomorrow)).toEqual(['b']);
    expect(ids(f.overdue)).toEqual(['c', 'f']);
    expect(f.done).toEqual([]);
    const p3 = filterByProject(groupTasks(list, today), 'p3');
    expect(p3.overdue).toEqual([]);
    expect(ids(p3.done)).toEqual(['d']);
    expect(filterByProject(groupTasks(list, today), null)).toEqual(groupTasks(list, today));
  });
});

describe('earlierPlans', () => {
  it('groups planned tasks due before today, newest date first, leaving out started, done and running ones', () => {
    const g = earlierPlans(
      [
        task('a', { dueDate: '2026-11-08' }),
        task('b', { dueDate: '2026-11-09' }),
        task('c', { dueDate: '2026-11-09', stage: 'blocked' }),
        task('d', { dueDate: '2026-11-09', stage: 'done', completed: true }),
        task('r', { dueDate: '2026-11-09', stage: 'in_progress', isRunning: true }),
        task('e'),
      ],
      today,
    );
    expect(g.map((x) => [x.date, ids(x.tasks)])).toEqual([
      ['2026-11-09', ['b']],
      ['2026-11-08', ['a']],
    ]);
  });
});
