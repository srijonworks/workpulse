import { describe, expect, it } from 'vitest';
import { BACKOFF, nextDelay } from './backoff';

const table = [1000, 2000, 4000];

describe('nextDelay', () => {
  it('walks the table and repeats the last delay', () => {
    const middle = () => 0.5; // no spread
    expect([1, 2, 3, 4, 10].map((n) => nextDelay(n, table, middle))).toEqual([1000, 2000, 4000, 4000, 4000]);
  });
  it('spreads each delay by at most ±20 %', () => {
    expect(nextDelay(1, table, () => 0)).toBe(800);
    expect(nextDelay(1, table, () => 0.999999)).toBe(1200);
    for (let i = 0; i < 200; i++) {
      const d = nextDelay(3, table);
      expect(d).toBeGreaterThanOrEqual(3200);
      expect(d).toBeLessThanOrEqual(4800);
    }
  });
  it('treats a first try below 1 and an empty table safely', () => {
    expect(nextDelay(0, table, () => 0.5)).toBe(1000);
    expect(nextDelay(-5, table, () => 0.5)).toBe(1000);
    expect(nextDelay(3, [], () => 0.5)).toBe(0);
  });
});

describe('BACKOFF tables', () => {
  it('only ever grow, and the long ones stop at their cap', () => {
    for (const t of Object.values(BACKOFF)) {
      for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
    }
    expect(BACKOFF.sync[BACKOFF.sync.length - 1]).toBe(30 * 60_000);
    expect(BACKOFF.diskCopy[BACKOFF.diskCopy.length - 1]).toBe(5 * 60_000);
  });
});
