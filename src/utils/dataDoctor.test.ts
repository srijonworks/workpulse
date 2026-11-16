import { describe, expect, it } from 'vitest';
import type { BacklogTask, Project, WorkLog } from '../types';
import { repairData, type DoctorData } from './dataDoctor';

process.env.TZ = 'Asia/Dhaka';

const log = (o: Partial<WorkLog> = {}): WorkLog => ({ id: 'l1', date: '2026-11-16', time: '10:00', projectId: 'p1', projectName: 'Core', description: 'work', status: 'Completed', tags: [], createdAt: '2026-11-16T04:00:00Z', ...o }) as WorkLog;
const task = (o: Partial<BacklogTask> = {}): BacklogTask => ({ id: 't1', title: 't', projectId: 'p1', dueDate: '2026-11-16', completed: false, originalDate: '2026-11-16', isRolledOver: false, ...o });
const proj = (id = 'p1'): Project => ({ id, name: 'Core', color: '#000', isArchived: false });
const data = (o: Partial<DoctorData> = {}): DoctorData => ({ logs: [log()], backlog: [task()], projects: [proj()], workdays: {}, ...o });

describe('repairData', () => {
  it('returns the same objects and no repairs for healthy data', () => {
    const d = data();
    const r = repairData(d);
    expect(r.repairs).toEqual([]);
    expect(r.logs).toBe(d.logs);
    expect(r.backlog).toBe(d.backlog);
    expect(r.projects).toBe(d.projects);
    expect(r.workdays).toBe(d.workdays);
  });

  it('gives repeated or missing ids new ones and keeps every record', () => {
    const r = repairData(data({ logs: [log(), log({ description: 'second' }), log({ id: '' as string })] }));
    expect(new Set(r.logs.map((l) => l.id)).size).toBe(3);
    expect(r.logs[1].description).toBe('second');
    expect(r.repairs.filter((x) => x.kind === 'log-id')).toHaveLength(2);
  });

  it('dates a log with a bad date from when it was created (local date)', () => {
    const r = repairData(data({ logs: [log({ date: 'yesterday', createdAt: '2026-11-15T20:30:00Z' })] }));
    expect(r.logs[0].date).toBe('2026-11-16'); // 02:30 in Dhaka
  });

  it('clears impossible minutes and seconds only', () => {
    const r = repairData(data({ logs: [log({ durationMinutes: NaN }), log({ id: 'l2', durationMinutes: 30 })], backlog: [task({ elapsedSeconds: NaN }), task({ id: 't2', elapsedSeconds: 90 })] }));
    expect(r.logs[0].durationMinutes).toBeUndefined();
    expect(r.logs[1].durationMinutes).toBe(30);
    expect(r.backlog[0].elapsedSeconds).toBe(0);
    expect(r.backlog[1].elapsedSeconds).toBe(90);
  });

  it('adds a placeholder project for work whose project is gone', () => {
    const r = repairData(data({ logs: [log({ projectId: 'gone', projectName: 'Old project' })], backlog: [task({ projectId: 'gone2' })] }));
    expect(r.projects.map((p) => [p.id, p.name])).toEqual([['p1', 'Core'], ['gone', 'Old project'], ['gone2', 'Recovered project']]);
  });

  it('drops a clock-out that is before its clock-in', () => {
    const r = repairData(data({ workdays: { '2026-11-16': { clockIn: '2026-11-16T04:00:00Z', clockOut: '2026-11-16T03:00:00Z' }, '2026-11-15': { clockIn: '2026-11-15T04:00:00Z', clockOut: '2026-11-15T12:00:00Z' } } }));
    expect(r.workdays['2026-11-16']).toEqual({ clockIn: '2026-11-16T04:00:00Z' });
    expect(r.workdays['2026-11-15'].clockOut).toBeDefined();
  });

  it('is idempotent', () => {
    const first = repairData(data({ logs: [log(), log()], backlog: [task({ elapsedSeconds: -5 })], projects: [] }));
    const second = repairData(first);
    expect(second.repairs).toEqual([]);
    expect(second.logs).toBe(first.logs);
  });
});
