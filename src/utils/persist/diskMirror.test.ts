import { describe, expect, it, vi } from 'vitest';
import type { NetResult } from '../net/http';
import { createDiskMirror, type MirrorDeps } from './diskMirror';
import type { EngineStatus } from './engine';

const status = (o: Partial<EngineStatus> = {}): EngineStatus => ({ dirtyKeys: [], blockedKeys: [], frozen: false, notSaved: false, rev: 1, profileId: 'p1', ...o });
const OK: NetResult<unknown> = { ok: true, status: 200, data: {} };

function setup(over: Partial<MirrorDeps> = {}, sendResults: NetResult<unknown>[] = []) {
  let s = status();
  const listeners = new Set<() => void>();
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const send = vi.fn(async (_body: Parameters<MirrorDeps['send']>[0], _o: Parameters<MirrorDeps['send']>[1]): Promise<NetResult<unknown>> => sendResults.shift() ?? OK);
  const states: string[] = [];
  const mirror = createDiskMirror({
    engine: { status: () => s, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) },
    readRaw: () => ({ workpulse_logs: '[{"id":"a"}]' }),
    send,
    ready: () => true,
    hasRealData: () => true,
    onState: (x) => states.push(x.kind),
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    ...over,
  });
  const advance = async (ms: number) => {
    t += ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  const change = (rev: number) => {
    s = status({ rev });
    for (const l of [...listeners]) l();
  };
  return { mirror, send, states, advance, change, setStatus: (o: Partial<EngineStatus>) => (s = status(o)) };
}

describe('sending the copy', () => {
  it('sends the raw stored text a few seconds after start, with the profile and revision', async () => {
    const { mirror, send, advance } = setup();
    mirror.start();
    await advance(3_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ profileId: 'p1', rev: 1, keys: { workpulse_logs: '[{"id":"a"}]' }, takeover: false }, expect.objectContaining({ keepalive: false }));
    expect(mirror.state()).toMatchObject({ kind: 'ok', rev: 1 });
  });

  it('batches quick changes into one send and keeps 15 seconds between sends', async () => {
    const { mirror, send, advance, change } = setup();
    mirror.start();
    await advance(3_000);
    change(2);
    change(3);
    await advance(3_000); // too soon after the last send
    expect(send).toHaveBeenCalledTimes(1);
    await advance(12_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ rev: 3 });
  });

  it('sends nothing for a browser that holds only demo data, an unreadable list, or a read-only window', async () => {
    const a = setup({ hasRealData: () => false });
    a.mirror.start();
    await a.advance(3_000);
    expect(a.send).not.toHaveBeenCalled();
    expect(a.mirror.state()).toMatchObject({ kind: 'paused' });

    const b = setup();
    b.setStatus({ blockedKeys: ['workpulse_logs'] });
    b.mirror.start();
    await b.advance(3_000);
    expect(b.send).not.toHaveBeenCalled();

    const c = setup();
    c.setStatus({ frozen: true });
    c.mirror.start();
    await c.advance(3_000);
    expect(c.send).not.toHaveBeenCalled();
  });

  it('waits for the start-up check, then sends', async () => {
    let ready = false;
    const { mirror, send, advance } = setup({ ready: () => ready });
    mirror.start();
    await advance(3_000);
    expect(send).not.toHaveBeenCalled();
    ready = true;
    await advance(3_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flush sends at once, with keepalive, ignoring the wait between sends', async () => {
    const { mirror, send, advance, change } = setup();
    mirror.start();
    await advance(3_000);
    change(2);
    await mirror.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toMatchObject({ keepalive: true });
  });
});

describe('when the copy cannot be written', () => {
  it('says so, keeps trying with growing waits, and recovers', async () => {
    const bad: NetResult<unknown> = { ok: false, kind: 'http', status: 500, message: 'The server could not do that.', data: { message: 'The disk is full.' }, retryable: true };
    const { mirror, send, advance } = setup({}, [bad, bad]);
    mirror.start();
    await advance(3_000);
    expect(mirror.state()).toMatchObject({ kind: 'failing', message: 'The disk is full.' });
    await advance(15_000); // the retry still keeps 15 seconds from the last send
    expect(send).toHaveBeenCalledTimes(2);
    await advance(40_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(mirror.state()).toMatchObject({ kind: 'ok' });
  });
});

describe('another browser profile owns the copy', () => {
  const conflict: NetResult<unknown> = { ok: false, kind: 'http', status: 409, message: 'x', data: { code: 'other-profile' }, retryable: false };

  it('stops sending, and takes over only when allowed', async () => {
    const { mirror, send, advance, change } = setup({}, [conflict]);
    mirror.start();
    await advance(3_000);
    expect(mirror.state()).toEqual({ kind: 'conflict' });
    change(2);
    await advance(30_000);
    expect(send).toHaveBeenCalledTimes(1);

    mirror.allowTakeOver();
    await advance(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ takeover: true });
    expect(mirror.state()).toMatchObject({ kind: 'ok' });
  });

  it('a copy that is already newer pauses quietly instead of failing', async () => {
    const stale: NetResult<unknown> = { ok: false, kind: 'http', status: 409, message: 'x', data: { code: 'stale' }, retryable: false };
    const { mirror, advance } = setup({}, [stale]);
    mirror.start();
    await advance(3_000);
    expect(mirror.state()).toMatchObject({ kind: 'paused' });
  });
});
