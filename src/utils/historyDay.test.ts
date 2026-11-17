process.env.TZ = 'Asia/Dhaka';
import { describe, expect, it } from 'vitest';
import type { BacklogTask, Project, WorkLog } from '../types';
import { dayRangeMs, dayToCsv, dayToMarkdown, hm, parseDateQuery, summarizeDay } from './historyDay';

const TODAY = '2026-11-17';
const log = (o: Partial<WorkLog> = {}): WorkLog =>
  ({ id: 'l1', date: '2026-11-16', time: '10:00', projectId: 'p1', projectName: 'Acme', description: 'Did a thing',
    status: 'completed', tags: [], durationMinutes: 90, ...o }) as WorkLog;
const task = (o: Partial<BacklogTask> = {}): BacklogTask => ({
  id: 't1', title: 'Fix it', projectId: 'p1', dueDate: '2026-11-16', completed: true, stage: 'done',
  originalDate: '2026-11-16', isRolledOver: false, completedAt: '2026-11-16T05:00:00.000Z', ...o,
});
const projects = [{ id: 'p1', name: 'Acme', color: '#000', isArchived: false }] as Project[];

describe('parseDateQuery', () => {
  it('reads dates and words', () => {
    expect(parseDateQuery('2026-11-14', TODAY)).toBe('2026-11-14');
    expect(parseDateQuery(' Yesterday ', TODAY)).toBe('2026-11-16');
    expect(parseDateQuery('TODAY', TODAY)).toBe(TODAY);
  });
  it('rejects other text and impossible dates', () => {
    expect(parseDateQuery('2026-13-40', TODAY)).toBeNull();
    expect(parseDateQuery('2026-02-30', TODAY)).toBeNull();
    expect(parseDateQuery('standup', TODAY)).toBeNull();
    expect(parseDateQuery('', TODAY)).toBeNull();
  });
});

describe('dayRangeMs', () => {
  it('spans 24 hours from local midnight (Dhaka)', () => {
    const r = dayRangeMs('2026-11-16');
    expect(new Date(r.fromMs).toISOString()).toBe('2026-11-15T18:00:00.000Z');
    expect(r.toMs - r.fromMs).toBe(86_400_000);
  });
});

describe('summarizeDay', () => {
  const base = { date: '2026-11-16', today: TODAY, nowMs: Date.parse('2026-11-17T04:00:00.000Z') };
  it('shows clock times, worked, logged, tracked and done tasks', () => {
    const s = summarizeDay({
      ...base,
      logs: [log(), log({ id: 'l2', date: TODAY }), log({ id: 'l3', durationMinutes: undefined, time: '09:00' })],
      workdays: { '2026-11-16': { clockIn: '2026-11-16T03:00:00.000Z', clockOut: '2026-11-16T11:30:00.000Z' } },
      backlog: [
        task({ segments: [{ start: '2026-11-16T04:00:00.000Z', end: '2026-11-16T05:30:00.000Z' }] }),
        task({ id: 't2', completedAt: '2026-11-17T01:00:00.000Z' }),
      ],
    });
    expect(s.logs.map((l) => l.id)).toEqual(['l3', 'l1']);
    expect(s.workedSec).toBe(8.5 * 3600);
    expect(s.loggedMinutes).toBe(90);
    expect(s.trackedSec).toBe(5400);
    expect(s.doneTasks.map((t) => t.id)).toEqual(['t1']);
    expect(s.noClockOut).toBe(false);
  });
  it('a day with a clock-in and no logs still has times; an old open day has no worked figure', () => {
    const s = summarizeDay({ ...base, logs: [], backlog: [], workdays: { '2026-11-16': { clockIn: '2026-11-16T03:00:00.000Z' } } });
    expect(s.clockIn).not.toBeNull();
    expect(s.noClockOut).toBe(true);
    expect(s.workedSec).toBeNull();
  });
  it("counts today's open day up to now", () => {
    const s = summarizeDay({ ...base, date: TODAY, logs: [], backlog: [], workdays: { [TODAY]: { clockIn: '2026-11-17T02:00:00.000Z' } } });
    expect(s.workedSec).toBe(7200);
  });
});

describe('exports', () => {
  const s = summarizeDay({
    date: '2026-11-16', today: TODAY, nowMs: Date.parse('2026-11-17T04:00:00.000Z'),
    logs: [log()], backlog: [task()],
    workdays: { '2026-11-16': { clockIn: '2026-11-16T03:00:00.000Z', clockOut: '2026-11-16T11:00:00.000Z' } },
  });
  it('markdown has times, figures, tasks, logs and standup', () => {
    const md = dayToMarkdown(s, projects, 'Yesterday I did it.');
    expect(md).toContain('# 2026-11-16');
    expect(md).toContain('Clocked in: 09:00');
    expect(md).toContain('Clocked out: 17:00');
    expect(md).toContain('Worked: 8:00');
    expect(md).toContain('Logged: 1:30');
    expect(md).toContain('- Fix it (Acme)');
    expect(md).toContain('**[Acme]** Did a thing (90m)');
    expect(md).toContain('## Standup\nYesterday I did it.');
  });
  it('markdown says so when the day is empty', () => {
    const e = summarizeDay({ date: '2026-11-10', today: TODAY, nowMs: 0, logs: [], backlog: [], workdays: {} });
    const md = dayToMarkdown(e, projects);
    expect(md).toContain('No clock-in recorded');
    expect(md).toContain('Nothing logged.');
    expect(md).not.toContain('Standup');
  });
  it('csv holds only the day logs; hm formats', () => {
    expect(dayToCsv(s).trim().split('\n').length).toBe(2);
    expect(hm(3700)).toBe('1:01');
  });
});
