import { describe, expect, it } from 'vitest';
import { sheetSendState } from './sheetSendState';

describe('sheetSendState', () => {
  const base = { linked: true, clockedOut: true, pending: false, pushFailed: false };
  it('says nothing without a Sheet link or before the clock-out', () => {
    expect(sheetSendState({ ...base, linked: false })).toBeNull();
    expect(sheetSendState({ ...base, clockedOut: false, pending: true })).toBeNull();
  });
  it('is sent when the Sheet has the current state, even after an earlier failure', () => {
    expect(sheetSendState(base)).toBe('sent');
    expect(sheetSendState({ ...base, pushFailed: true })).toBe('sent');
  });
  it('is sending while a push is due, and failed when the last push failed', () => {
    expect(sheetSendState({ ...base, pending: true })).toBe('sending');
    expect(sheetSendState({ ...base, pending: true, pushFailed: true })).toBe('failed');
  });
});
