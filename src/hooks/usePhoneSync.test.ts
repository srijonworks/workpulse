import { describe, it, expect, vi } from 'vitest';
import type { BacklogTask, Project } from '../types';
import { mergeInbox, type InboxItem } from '../utils/phoneSync';
import { shouldPush, pullAndMerge, combinedError, newClockOut, pushRetryDelay, RUNNING_PUSH_MS } from './usePhoneSync';

process.env.TZ = 'Asia/Dhaka';

const TODAY = '2026-11-11';
const projects: Project[] = [{ id: 'p1', name: 'Bengal Grid', color: '#10b981', isArchived: false }];
const item = (id: string, title = `Task ${id}`): InboxItem => ({
  id,
  title,
  projectId: 'p1',
  projectName: 'Bengal Grid',
  dueDate: TODAY,
  createdAt: '2026-11-11T01:00:00.000Z',
});

describe('shouldPush', () => {
  const base = { signature: 'a', lastSignature: 'a', lastPushAtMs: 1_000, nowMs: 2_000, running: false };

  it('pushes when the signature changed', () => {
    expect(shouldPush({ ...base, signature: 'b' })).toBe(true);
  });

  it('pushes the first time (nothing pushed yet)', () => {
    expect(shouldPush({ ...base, lastSignature: null, lastPushAtMs: null })).toBe(true);
  });

  it('does not push when nothing changed and no timer runs', () => {
    expect(shouldPush({ ...base, nowMs: base.lastPushAtMs + RUNNING_PUSH_MS * 3 })).toBe(false);
  });

  it('while a timer runs, pushes again only after 5 minutes', () => {
    expect(shouldPush({ ...base, running: true, nowMs: base.lastPushAtMs + RUNNING_PUSH_MS - 1 })).toBe(false);
    expect(shouldPush({ ...base, running: true, nowMs: base.lastPushAtMs + RUNNING_PUSH_MS })).toBe(true);
  });
});

// A fake desktop: a backlog in memory plus a "storage" copy that only changes when a save succeeds.
function desktop(items: InboxItem[], opts: { saveOk?: boolean; ackOk?: boolean } = {}) {
  const state = { backlog: [] as BacklogTask[], stored: [] as BacklogTask[], inbox: [...items] };
  const saveOk = { value: opts.saveOk ?? true };
  const ackOk = { value: opts.ackOk ?? true };
  const deps = {
    pull: vi.fn(async () => ({ ok: true, message: 'Inbox checked.', data: { items: state.inbox } })),
    merge: vi.fn((list: InboxItem[]) => mergeInbox(state.backlog, projects, list, TODAY)),
    save: vi.fn((next: BacklogTask[]) => {
      if (!saveOk.value) return false;
      state.backlog = next;
      state.stored = next;
      return true;
    }),
    ack: vi.fn(async (ids: string[]) => {
      if (!ackOk.value) return { ok: false, message: 'Could not reach your Google Sheet.' };
      state.inbox = state.inbox.filter((it) => !ids.includes(it?.id));
      return { ok: true, message: 'Inbox cleared.' };
    }),
  };
  return { state, deps, saveOk, ackOk };
}

describe('pullAndMerge', () => {
  it('saves the new tasks, then acks them', async () => {
    const d = desktop([item('phone-1'), item('phone-2')]);
    const out = await pullAndMerge(d.deps);
    expect(out.added.map((t) => t.id)).toEqual(['phone-1', 'phone-2']);
    expect(out.error).toBeUndefined();
    expect(d.state.stored.map((t) => t.id)).toEqual(['phone-1', 'phone-2']);
    expect(d.deps.ack).toHaveBeenCalledWith(['phone-1', 'phone-2']);
    expect(d.deps.save.mock.invocationCallOrder[0]).toBeLessThan(d.deps.ack.mock.invocationCallOrder[0]);
    expect(d.state.inbox).toEqual([]);
  });

  it('a failed save means no ack, and nothing is lost', async () => {
    const d = desktop([item('phone-1')], { saveOk: false });
    const out = await pullAndMerge(d.deps);
    expect(out.added).toEqual([]);
    expect(out.error).toMatch(/could not save/i);
    expect(d.deps.ack).not.toHaveBeenCalled();
    expect(d.state.inbox.map((i) => i.id)).toEqual(['phone-1']);

    // Next cycle, storage works again: the task arrives.
    d.saveOk.value = true;
    const again = await pullAndMerge(d.deps);
    expect(again.added.map((t) => t.id)).toEqual(['phone-1']);
    expect(d.state.inbox).toEqual([]);
  });

  it('an ack failure keeps the tasks, and a retry adds no duplicates', async () => {
    const d = desktop([item('phone-1'), item('phone-2')], { ackOk: false });
    const first = await pullAndMerge(d.deps);
    expect(first.added).toHaveLength(2);
    expect(first.error).toBeTruthy();
    expect(d.state.stored).toHaveLength(2);
    expect(d.state.inbox).toHaveLength(2);

    d.ackOk.value = true;
    const second = await pullAndMerge(d.deps);
    expect(second.added).toEqual([]);
    expect(d.state.stored.map((t) => t.id)).toEqual(['phone-1', 'phone-2']);
    expect(d.deps.ack).toHaveBeenLastCalledWith(['phone-1', 'phone-2']);
    expect(d.state.inbox).toEqual([]);
  });

  it('a failed pull changes nothing', async () => {
    const d = desktop([item('phone-1')]);
    d.deps.pull.mockResolvedValueOnce({ ok: false, message: 'Could not reach your Google Sheet.' } as never);
    const out = await pullAndMerge(d.deps);
    expect(out).toEqual({ added: [], error: 'Could not reach your Google Sheet.' });
    expect(d.deps.save).not.toHaveBeenCalled();
    expect(d.deps.ack).not.toHaveBeenCalled();
  });

  it('an answer with no items key is an empty inbox', async () => {
    const d = desktop([]);
    d.deps.pull.mockResolvedValueOnce({ ok: true, message: 'Inbox checked.', data: {} } as never);
    const out = await pullAndMerge(d.deps);
    expect(out).toEqual({ added: [] });
    expect(d.deps.save).not.toHaveBeenCalled();
  });

  it('one bad item does not stop the others', async () => {
    const bad = [null, 42, { title: 'no id' }, { id: 'phone-x', title: 7 }] as unknown as InboxItem[];
    const d = desktop([...bad, item('phone-1')]);
    const out = await pullAndMerge(d.deps);
    expect(out.added.map((t) => t.id)).toEqual(['phone-1']);
    expect(d.deps.ack).toHaveBeenCalledWith(['phone-x', 'phone-1']);
  });
});

describe('combinedError', () => {
  it('a pull success does not hide a push failure', () => {
    expect(combinedError({ push: 'Push failed.', pull: undefined })).toBe('Push failed.');
  });
  it('shows the pull failure when pushes work', () => {
    expect(combinedError({ push: undefined, pull: 'Pull failed.' })).toBe('Pull failed.');
  });
  it('nothing when both work', () => {
    expect(combinedError({})).toBeUndefined();
  });
});

describe('newClockOut', () => {
  const open = { '2026-11-19': { clockIn: '2026-11-19T02:40:00.000Z' } };
  const closed = { '2026-11-19': { clockIn: '2026-11-19T02:40:00.000Z', clockOut: '2026-11-19T10:19:00.000Z' } };
  it('is true when a clock-out appears or changes, so the Sheet hears of it at once', () => {
    expect(newClockOut(open, closed)).toBe(true);
    expect(newClockOut(closed, { '2026-11-19': { ...closed['2026-11-19'], clockOut: '2026-11-19T11:00:00.000Z' } })).toBe(true);
  });
  it('is false on the first look, with no change, on a clock-in or on a Resume', () => {
    expect(newClockOut(null, closed)).toBe(false);
    expect(newClockOut(closed, { ...closed })).toBe(false);
    expect(newClockOut({}, open)).toBe(false);
    expect(newClockOut(closed, open)).toBe(false);
  });
});

describe('pushRetryDelay', () => {
  it('retries a failed push after 10 s, 10 s, 20 s and 40 s, then leaves it to the minute cycle', () => {
    expect([1, 2, 3, 4].map(pushRetryDelay)).toEqual([10_000, 10_000, 20_000, 40_000]);
    expect(pushRetryDelay(5)).toBeNull();
    expect(pushRetryDelay(0)).toBeNull();
  });
});
