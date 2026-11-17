import { describe, expect, it } from 'vitest';
import { addDaysIso, addMonths, formatDate, formatDateLong, formatDateShort, monthGrid, parseIso, withinLimits } from './calendar';

describe('parseIso', () => {
  it('accepts real dates only', () => {
    expect(parseIso('2026-11-17')).toEqual({ y: 2026, m0: 10, d: 17 });
    expect(parseIso('2026-02-30')).toBeNull();
    expect(parseIso('2026-13-01')).toBeNull();
    expect(parseIso('17-11-2026')).toBeNull();
    expect(parseIso('')).toBeNull();
  });
});

describe('monthGrid', () => {
  it('always gives six Sunday-first weeks that contain the whole month', () => {
    const g = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(g).toHaveLength(42);
    expect(g[0]).toEqual({ iso: '2026-11-01', day: 1, inMonth: true });
    expect(g.filter((c) => c.inMonth)).toHaveLength(30);
    expect(g[41].iso).toBe('2026-12-12');
  });
  it('starts on the Sunday before a month that begins mid-week', () => {
    const g = monthGrid(2026, 11); // December 2026 starts on a Tuesday
    expect(g[0]).toEqual({ iso: '2026-11-29', day: 29, inMonth: false });
    expect(g[2]).toEqual({ iso: '2026-12-01', day: 1, inMonth: true });
  });
});

describe('moving around', () => {
  it('adds months across a year end, and days across a month end', () => {
    expect(addMonths(2026, 11, 1)).toEqual({ y: 2027, m0: 0 });
    expect(addMonths(2026, 0, -1)).toEqual({ y: 2025, m0: 11 });
    expect(addDaysIso('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('text and limits', () => {
  it('formats a date for the button and for screen readers', () => {
    expect(formatDate('2026-11-17')).toBe('Tue 17 Nov 2026');
    expect(formatDate('nope')).toBe('');
    expect(formatDateShort('2026-11-17')).toBe('17 Nov 2026');
    expect(formatDateLong('2026-11-17')).toBe('Tuesday 17 November 2026');
  });
  it('checks min and max', () => {
    expect(withinLimits('2026-11-17', undefined, '2026-11-17')).toBe(true);
    expect(withinLimits('2026-11-18', undefined, '2026-11-17')).toBe(false);
    expect(withinLimits('2026-11-01', '2026-11-02')).toBe(false);
  });
});
