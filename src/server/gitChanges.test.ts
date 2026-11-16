import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGitChanges } from './gitChanges';
import type { GitRunner } from './activityReaders';

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const range = { startIso: '2026-11-15T18:00:00.000Z', endIso: '2026-11-16T18:00:00.000Z' };

const setup = (files: Record<string, string>) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-wip-'));
  fs.mkdirSync(path.join(dir, '.git'));
  for (const [name, iso] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.utimesSync(path.join(dir, name), new Date(iso), new Date(iso));
  }
};

describe('readGitChanges', () => {
  it('makes one item per repo from changed files whose time is in the day', async () => {
    setup({ 'a.ts': '2026-11-16T05:00:00Z', 'b.ts': '2026-11-16T07:00:00Z', 'old.ts': '2026-11-01T05:00:00Z' });
    const runGit: GitRunner = async () => ({ stdout: ' M a.ts\0 M b.ts\0 M old.ts\0 D gone.ts\0' });
    const r = await readGitChanges([dir], range, runGit);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ source: 'git', folder: dir, time: '2026-11-16T07:00:00.000Z', text: 'Uncommitted changes in 2 files: b.ts, a.ts' });
    expect(r.items[0].id).toMatch(/^wip:2026-11-15:[0-9a-f]{10}$/);
  });

  it('gives nothing for a clean repo, and a plain note when git fails', async () => {
    setup({});
    expect((await readGitChanges([dir], range, async () => ({ stdout: '' }))).items).toEqual([]);
    const bad: GitRunner = async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    };
    const r = await readGitChanges([dir], range, bad);
    expect(r.items).toEqual([]);
    expect(r.notes[0]).toMatch(/Git is not installed/);
  });
});
