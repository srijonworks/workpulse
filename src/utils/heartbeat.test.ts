import { describe, expect, it } from 'vitest';
import { GAP_MS, HEARTBEAT_KEY, gapDecision, readHeartbeat, writeHeartbeat } from './heartbeat';

const kv = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('heartbeat storage', () => {
  it('writes and reads the time', () => {
    const s = kv();
    expect(writeHeartbeat(s, 1_700_000_000_000.7)).toBe(true);
    expect(s.m.get(HEARTBEAT_KEY)).toBe('1700000000000');
    expect(readHeartbeat(s, 1_700_000_100_000)).toBe(1_700_000_000_000);
  });

  it('survives storage that throws', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(writeHeartbeat(bad, 1)).toBe(false);
    expect(readHeartbeat(bad, 1)).toBeNull();
  });

  it('ignores missing, junk, and future values', () => {
    const s = kv();
    expect(readHeartbeat(s, 1000)).toBeNull();
    s.m.set(HEARTBEAT_KEY, 'abc');
    expect(readHeartbeat(s, 1000)).toBeNull();
    s.m.set(HEARTBEAT_KEY, String(1000 + 3_600_000));
    expect(readHeartbeat(s, 1000)).toBeNull();
  });
});

describe('gapDecision', () => {
  const now = 10_000_000;
  it('says nothing for a short gap or no earlier beat', () => {
    expect(gapDecision({ lastBeatMs: now - GAP_MS + 1, nowMs: now, explainedBySleep: false })).toEqual({ kind: 'none' });
    expect(gapDecision({ lastBeatMs: null, nowMs: now, explainedBySleep: false })).toEqual({ kind: 'none' });
  });
  it('calls a long gap that sleep explains quiet', () => {
    expect(gapDecision({ lastBeatMs: now - 47 * 60_000, nowMs: now, explainedBySleep: true })).toEqual({ kind: 'sleep', minutes: 47 });
  });
  it('calls a long gap nothing explains unexplained', () => {
    expect(gapDecision({ lastBeatMs: now - 47 * 60_000, nowMs: now, explainedBySleep: false })).toEqual({ kind: 'unexplained', minutes: 47 });
  });
});
