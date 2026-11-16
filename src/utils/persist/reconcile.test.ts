import { describe, expect, it } from 'vitest';
import type { CopyMeta } from './copyFormat';
import { decide, hasRealStoredData, type LocalState } from './reconcile';

const copy = (o: Partial<CopyMeta> = {}): CopyMeta => ({
  format: 1,
  profileId: 'old',
  origin: 'localhost:3000',
  rev: 40,
  savedAt: '2026-11-16T10:00:00Z',
  counts: { logs: 12, tasks: 3, projects: 2, workdays: 5 },
  sha256: 'x',
  ...o,
});
const real = { workpulse_logs: JSON.stringify([{ id: 'log-1731000000000' }]) };
const local = (o: Partial<LocalState> = {}): LocalState => ({ profileId: 'new', rev: 1, raw: real, blockedKeys: [], ...o });

describe('hasRealStoredData', () => {
  it('ignores the demo data and unreadable text, counts anything the user made', () => {
    expect(hasRealStoredData({})).toBe(false);
    expect(hasRealStoredData({ workpulse_logs: JSON.stringify([{ id: 'log-1' }]), workpulse_tags: '["x"]' })).toBe(false);
    expect(hasRealStoredData({ workpulse_logs: '{broken' })).toBe(false);
    expect(hasRealStoredData(real)).toBe(true);
    expect(hasRealStoredData({ workpulse_workdays: JSON.stringify({ '2026-11-16': { clockIn: 'x' } }) })).toBe(true);
  });
});

describe('decide', () => {
  it('does nothing without a copy, or with an empty one', () => {
    expect(decide(local(), null)).toEqual({ action: 'none' });
    expect(decide(local({ raw: {} }), copy({ counts: { logs: 0, tasks: 0, projects: 0, workdays: 0 } }))).toEqual({ action: 'none' });
  });

  it('offers the copy to a browser that holds nothing real (wiped or new)', () => {
    expect(decide(local({ raw: {} }), copy())).toEqual({ action: 'offer-restore', reason: 'empty' });
    expect(decide(local({ raw: { workpulse_logs: JSON.stringify([{ id: 'log-1' }]) } }), copy())).toEqual({ action: 'offer-restore', reason: 'empty' });
  });

  it('puts back keys that could not be read, from the copy, without asking', () => {
    const keys = { workpulse_logs: '[]', workpulse_tags: '[]' };
    expect(decide(local({ blockedKeys: ['workpulse_logs', 'workpulse_settings'] }), copy(), keys)).toEqual({ action: 'restore-keys', keys: ['workpulse_logs'] });
  });

  it('offers the copy when the same profile is behind it, and leaves it alone when it is level or ahead', () => {
    expect(decide(local({ profileId: 'old', rev: 30 }), copy())).toEqual({ action: 'offer-restore', reason: 'behind' });
    expect(decide(local({ profileId: 'old', rev: 40 }), copy())).toEqual({ action: 'none' });
    expect(decide(local({ profileId: 'old', rev: 50 }), copy())).toEqual({ action: 'none' });
  });

  it('keeps this browser\'s data when another profile left a copy and this one has real work', () => {
    expect(decide(local(), copy())).toEqual({ action: 'take-over' });
  });
});
