process.env.TZ = 'Asia/Dhaka';
import { describe, it, expect } from 'vitest';
import { startSegment, endSegment, ensureOpenSegment, buildOvers, pauseRunningAt, splitSegmentsAtGap, workBuckets } from './segments';
import type { BacklogTask, Project } from '../types';

const task = (over: Partial<BacklogTask> = {}): BacklogTask => ({
  id: 't1',
  title: 'T',
  projectId: 'pa',
  dueDate: '2026-11-10',
  completed: false,
  originalDate: '2026-11-10',
  isRolledOver: false,
  ...over,
});

// Dhaka is UTC+6: 09:00 local = 03:00Z.
const at = (hhmm: string) =>
  `2026-11-10T${String(Number(hhmm.slice(0, 2)) - 6).padStart(2, '0')}:${hhmm.slice(3)}:00.000Z`;
const ms = (hhmm: string) => Date.parse(at(hhmm));

describe('segments', () => {
  it('startSegment appends an open segment', () => {
    expect(startSegment(task(), 'A').segments).toEqual([{ start: 'A' }]);
  });
  it('startSegment twice does not add a second open segment', () => {
    const once = startSegment(task(), 'A');
    expect(startSegment(once, 'B').segments).toEqual([{ start: 'A' }]);
  });
  it('startSegment after a closed one appends', () => {
    const t = task({ segments: [{ start: 'A', end: 'B' }] });
    expect(startSegment(t, 'C').segments).toEqual([{ start: 'A', end: 'B' }, { start: 'C' }]);
  });
  it('endSegment closes the open segment', () => {
    expect(endSegment(task({ segments: [{ start: 'A' }] }), 'B').segments).toEqual([{ start: 'A', end: 'B' }]);
  });
  it('endSegment is a no-op with none open', () => {
    const t = task({ segments: [{ start: 'A', end: 'B' }] });
    expect(endSegment(t, 'C')).toBe(t);
    const none = task();
    expect(endSegment(none, 'C')).toBe(none);
  });
  it('ensureOpenSegment adds one only when none is open', () => {
    expect(ensureOpenSegment(task({ isRunning: true }), 'N').segments).toEqual([{ start: 'N' }]);
    const open = task({ segments: [{ start: 'A' }] });
    expect(ensureOpenSegment(open, 'N')).toBe(open);
  });
});

describe('buildOvers', () => {
  const rec = { clockIn: at('09:00') };
  const projects: Project[] = [
    { id: 'pa', name: 'Alpha', color: '#111111', isArchived: false },
    { id: 'pb', name: 'Beta', color: '#222222', isArchived: false },
  ];

  it("an earlier day's segments draw nothing", () => {
    const day = 24 * 3600_000;
    const old = task({ segments: [{ start: new Date(ms('09:00') - day).toISOString(), end: new Date(ms('12:00') - day).toISOString() }] });
    const balls = buildOvers(rec, 8, [old], projects, ms('12:05')).flatMap((o) => o.balls);
    expect(balls.some((b) => b.kind === 'project')).toBe(false);
  });

  it('8h day at 10:25 has 8 overs of 6 balls, labelled by hour', () => {
    const overs = buildOvers(rec, 8, [], projects, ms('10:25'));
    expect(overs).toHaveLength(8);
    expect(overs.every((o) => o.balls.length === 6)).toBe(true);
    expect(overs[0].label).toBe('09');
    expect(overs[1].label).toBe('10');
    expect(overs[1].startMs).toBe(ms('10:00'));
  });

  it('a 09:00-09:40 segment fills balls 0-3 of over 0; the now slot is now; later is empty', () => {
    const t = task({ segments: [{ start: at('09:00'), end: at('09:40') }] });
    const overs = buildOvers(rec, 8, [t], projects, ms('10:25'));
    for (let i = 0; i < 4; i++) {
      expect(overs[0].balls[i]).toEqual({ kind: 'project', color: '#111111', projectName: 'Alpha' });
    }
    expect(overs[0].balls[4]).toEqual({ kind: 'empty' });
    expect(overs[0].balls[5]).toEqual({ kind: 'empty' });
    // 10:20 to 10:30 is slot 8 = over 1, ball 2 (over 1 starts at 10:00).
    expect(overs[1].balls[2]).toEqual({ kind: 'now' });
    expect(overs[1].balls[3]).toEqual({ kind: 'empty' });
    for (const o of overs.slice(2)) expect(o.balls.every((b) => b.kind === 'empty')).toBe(true);
  });

  it('the project with more overlap in a slot wins', () => {
    const a = task({ id: 'a', projectId: 'pa', segments: [{ start: at('09:00'), end: at('09:04') }] });
    const b = task({ id: 'b', projectId: 'pb', segments: [{ start: at('09:04'), end: at('09:10') }] });
    const overs = buildOvers(rec, 8, [a, b], projects, ms('10:25'));
    expect(overs[0].balls[0]).toMatchObject({ kind: 'project', projectName: 'Beta' });
  });

  it('an unknown project is Unassigned grey', () => {
    const t = task({ projectId: 'gone', segments: [{ start: at('09:00'), end: at('09:10') }] });
    expect(buildOvers(rec, 8, [t], projects, ms('10:25'))[0].balls[0]).toEqual({
      kind: 'project',
      color: '#8a8f98',
      projectName: 'Unassigned',
    });
  });

  it('an open segment runs to now', () => {
    const t = task({ segments: [{ start: at('10:00') }] });
    const overs = buildOvers(rec, 8, [t], projects, ms('10:25'));
    expect(overs[1].balls[0]).toMatchObject({ kind: 'project' });
    expect(overs[1].balls[1]).toMatchObject({ kind: 'project' });
    expect(overs[1].balls[2]).toEqual({ kind: 'now' });
  });

  it('70 minutes past leave gives 10 overs', () => {
    expect(buildOvers(rec, 8, [], projects, ms('18:10'))).toHaveLength(10);
  });

  it('now exactly at the leave time still has a now ball (in a ninth over)', () => {
    const overs = buildOvers(rec, 8, [], projects, ms('17:00'));
    expect(overs).toHaveLength(9);
    expect(overs[8].label).toBe('17');
    expect(overs[8].balls[0]).toEqual({ kind: 'now' });
    expect(overs.flatMap((o) => o.balls).filter((b) => b.kind === 'now')).toHaveLength(1);
  });

  it('no segments: everything empty except now', () => {
    const balls = buildOvers(rec, 8, [], projects, ms('10:25')).flatMap((o) => o.balls);
    expect(balls.filter((b) => b.kind === 'now')).toHaveLength(1);
    expect(balls.filter((b) => b.kind === 'empty')).toHaveLength(47);
  });
});

describe('splitSegmentsAtGap', () => {
  it('closes an open segment at the last tick and reopens it at now after a long gap', () => {
    const tasks = [task({ segments: [{ start: at('09:00') }] })];
    const out = splitSegmentsAtGap(tasks, ms('10:00'), ms('11:30'));
    expect(out[0].segments).toEqual([
      { start: at('09:00'), end: at('10:00') },
      { start: at('11:30') },
    ]);
  });
  it('does nothing on a normal 1 s tick', () => {
    const tasks = [task({ segments: [{ start: at('09:00') }] })];
    expect(splitSegmentsAtGap(tasks, ms('10:00'), ms('10:00') + 1000)).toBe(tasks);
  });
  it('leaves a task with no open segment untouched', () => {
    const closed = task({ segments: [{ start: at('09:00'), end: at('09:30') }] });
    const none = task({ id: 't2' });
    const out = splitSegmentsAtGap([closed, none], ms('10:00'), ms('11:30'));
    expect(out[0]).toBe(closed);
    expect(out[1]).toBe(none);
  });
});

describe('workBuckets', () => {
  const t = (start: string, end?: string) => ({ segments: [{ start, end }] }) as never;
  const from = Date.parse('2026-01-01T09:00:00Z');
  it('shares each 15-minute piece by how long a timer ran in it', () => {
    const b = workBuckets([t('2026-01-01T09:00:00Z', '2026-01-01T09:15:00Z'), t('2026-01-01T09:30:00Z', '2026-01-01T09:37:30Z')], from, from + 3_600_000, from + 3_600_000);
    expect(b).toEqual([1, 0, 0.5, 0]);
  });
  it('ends an open segment at now and clamps overlaps to 1', () => {
    const now = from + 20 * 60_000;
    const b = workBuckets([t('2026-01-01T09:10:00Z'), t('2026-01-01T09:00:00Z', '2026-01-01T09:15:00Z')], from, from + 30 * 60_000, now);
    expect(b[0]).toBe(1);
    expect(b[1]).toBeCloseTo(5 / 15);
  });
});

import { segmentSecondsInRange } from './segments';

describe('segmentSecondsInRange', () => {
  const from = Date.parse('2026-11-09T18:00:00.000Z');
  const to = from + 24 * 3600_000;
  it('clips a segment to the range and runs an open one to now', () => {
    const t = task({ segments: [{ start: at('09:00'), end: at('10:00') }, { start: at('11:00') }] });
    expect(segmentSecondsInRange([t], from, to, ms('11:30'))).toBe(3600 + 1800);
    expect(segmentSecondsInRange([t], ms('09:30'), ms('09:45'), ms('11:30'))).toBe(900);
  });
  it('ignores segments outside the range', () => {
    const t = task({ segments: [{ start: at('09:00'), end: at('10:00') }] });
    expect(segmentSecondsInRange([t], ms('12:00'), to, ms('13:00'))).toBe(0);
    expect(segmentSecondsInRange([task()], from, to, ms('13:00'))).toBe(0);
  });
});

describe('pauseRunningAt (clock-out)', () => {
  it('pauses every running task at the clock-out and leaves the others alone', () => {
    const running = task({ id: 'r', stage: 'in_progress', isRunning: true, elapsedSeconds: 3600, segments: [{ start: at('09:00') }] });
    const planned = task({ id: 'p', stage: 'planned' });
    const out = pauseRunningAt([running, planned], at('10:00'), ms('10:00'));
    expect(out[0]).toMatchObject({ stage: 'paused', isRunning: false, elapsedSeconds: 3600, segments: [{ start: at('09:00'), end: at('10:00') }] });
    expect(out[1]).toBe(planned);
  });

  it('takes back the seconds counted after a clock-out stamped in the past', () => {
    const running = task({ stage: 'in_progress', isRunning: true, elapsedSeconds: 3 * 3600, segments: [{ start: at('09:00') }] });
    const [t] = pauseRunningAt([running], at('11:00'), ms('12:00'));
    expect(t.elapsedSeconds).toBe(2 * 3600);
    expect(t.segments?.[0].end).toBe(at('11:00'));
  });

  it('never takes back time from before the open segment started', () => {
    const running = task({ stage: 'in_progress', isRunning: true, elapsedSeconds: 7200, segments: [{ start: at('11:30') }] });
    const [t] = pauseRunningAt([running], at('11:00'), ms('12:00'));
    expect(t.elapsedSeconds).toBe(7200 - 1800);
    expect(t.segments?.[0].end).toBe(at('11:30'));
  });

  it('returns the same array when nothing runs', () => {
    const list = [task({ stage: 'paused' })];
    expect(pauseRunningAt(list, at('10:00'), ms('10:00'))).toBe(list);
  });
});
