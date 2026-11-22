// @vitest-environment node
process.env.TZ = 'Asia/Dhaka';
import { describe, it, expect, vi } from 'vitest';
import { writeStandupOnce, type StandupDeps } from './useStandups';
import { dayPeriod, weekPeriod } from '../utils/standup';
import { DEFAULT_SETTINGS } from '../data/seedData';
import type { StandupRecord, WorkLog } from '../types';

const log = (date: string): WorkLog => ({ id: date, date, time: '10:00', projectId: 'p', projectName: 'A', description: 'work', status: 'completed', tags: [], createdAt: 'c' });

function setup(over: Partial<StandupDeps> = {}) {
  let standups: StandupRecord[] = over.standups ?? [];
  const writer = vi.fn().mockResolvedValue({ text: 'T', writer: 'claude' });
  const deps: StandupDeps = {
    enabled: true, logs: [log('2026-11-12')], backlog: [], projects: [], settings: DEFAULT_SETTINGS, workdays: {},
    standups, setStandups: (f) => { standups = f(standups); }, writer, now: () => 'NOW', ...over,
  };
  return { deps, writer, get: () => standups };
}

describe('writeStandupOnce', () => {
  it('writes once and records the writer', async () => {
    const s = setup();
    const inF = new Set<string>();
    await writeStandupOnce(s.deps, dayPeriod('2026-11-12'), inF);
    expect(s.get()).toEqual([expect.objectContaining({ id: 'day:2026-11-12', text: 'T', writer: 'claude', createdAt: 'NOW' })]);
  });
  it('never overwrites an existing (edited) one', async () => {
    const ex: StandupRecord = { id: 'day:2026-11-12', kind: 'day', from: '2026-11-12', to: '2026-11-12', text: 'mine', writer: 'template', createdAt: 'c', editedAt: 'e' };
    const s = setup({ standups: [ex] });
    expect(await writeStandupOnce(s.deps, dayPeriod('2026-11-12'), new Set())).toBeNull();
    expect(s.writer).not.toHaveBeenCalled();
    expect(s.get()[0].text).toBe('mine');
  });
  it('skips when disabled, no logs, or the day is still open', async () => {
    expect(await writeStandupOnce(setup({ enabled: false }).deps, dayPeriod('2026-11-12'), new Set())).toBeNull();
    expect(await writeStandupOnce(setup({ logs: [] }).deps, dayPeriod('2026-11-12'), new Set())).toBeNull();
    const open = setup({ workdays: { '2026-11-12': { clockIn: '2026-11-12T03:00:00.000Z' } } });
    expect(await writeStandupOnce(open.deps, dayPeriod('2026-11-12'), new Set())).toBeNull();
  });
  it('records a notice when the writer fell back', async () => {
    const s = setup();
    s.writer.mockResolvedValue({ text: 'plain', writer: 'template', notice: 'Claude is not signed in.' });
    await writeStandupOnce(s.deps, dayPeriod('2026-11-12'), new Set());
    expect(s.get()[0]).toMatchObject({ writer: 'template', notice: 'Claude is not signed in.' });
  });
  it('week standup uses the day standups and the whole window', async () => {
    const day: StandupRecord = { id: 'day:2026-11-10', kind: 'day', from: '2026-11-10', to: '2026-11-10', text: 'Tuesday summary', writer: 'claude', createdAt: 'c' };
    const s = setup({ logs: [log('2026-11-06'), log('2026-11-12')], standups: [day] });
    await writeStandupOnce(s.deps, weekPeriod('2026-11-12'), new Set());
    const arg = s.writer.mock.calls[0][0];
    expect(arg.logs).toHaveLength(2);
    expect(arg.context).toContain('Tuesday summary');
    expect(s.get().map((x) => x.id)).toContain('week:2026-11-12');
  });
  it('does not start twice while one is in flight', async () => {
    const s = setup();
    const inF = new Set<string>();
    await Promise.all([writeStandupOnce(s.deps, dayPeriod('2026-11-12'), inF), writeStandupOnce(s.deps, dayPeriod('2026-11-12'), inF)]);
    expect(s.writer).toHaveBeenCalledTimes(1);
  });
});
