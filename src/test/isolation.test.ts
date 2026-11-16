import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The tripwire for src/test/isolateHome.ts: tests must run against a temp home and a temp WorkPulse folder.
const tmp = path.resolve(os.tmpdir()).toLowerCase();
const inTemp = (p: string) => path.resolve(p).toLowerCase().startsWith(tmp + path.sep);

describe('test isolation', () => {
  it('keeps the home folder inside the temp folder', () => {
    expect(inTemp(os.homedir())).toBe(true);
  });

  it('keeps the WorkPulse data folder inside the temp folder', () => {
    expect(process.env.WORKPULSE_DATA_DIR).toBeTruthy();
    expect(inTemp(process.env.WORKPULSE_DATA_DIR as string)).toBe(true);
  });
});
