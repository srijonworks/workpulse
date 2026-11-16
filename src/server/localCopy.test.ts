import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalCopy, originFolder, parseCopyFile } from './localCopy';

let root: string;
let clock = Date.parse('2026-11-16T10:00:00Z');
const make = () => createLocalCopy(root, { now: () => new Date(clock) });
const keys = (n: number) => ({ workpulse_logs: JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `l${i}` }))) });
const ORIGIN = 'localhost:3000';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-copy-'));
  clock = Date.parse('2026-11-16T10:00:00Z');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('writing and reading a copy', () => {
  it('writes a copy with counts and a checksum, and reads it back', async () => {
    const c = make();
    const w = await c.write(ORIGIN, { profileId: 'p1', rev: 1, keys: keys(3) });
    expect(w).toMatchObject({ ok: true, written: true });
    const r = await c.read(ORIGIN);
    expect(r.copy).toMatchObject({ profileId: 'p1', rev: 1, counts: { logs: 3 } });
    expect(r.damaged).toBe(false);
  });

  it('keeps the file before as prev.json and a daily copy', async () => {
    const c = make();
    await c.write(ORIGIN, { profileId: 'p1', rev: 1, keys: keys(1) });
    await c.write(ORIGIN, { profileId: 'p1', rev: 2, keys: keys(2) });
    const dir = path.join(root, originFolder(ORIGIN));
    expect(parseCopyFile(fs.readFileSync(path.join(dir, 'prev.json'), 'utf8'))?.rev).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'daily'))).toEqual(['2026-11-16.json']);
  });

  it('never replaces a newer copy with an older one, and ignores an unchanged one', async () => {
    const c = make();
    await c.write(ORIGIN, { profileId: 'p1', rev: 5, keys: keys(5) });
    expect(await c.write(ORIGIN, { profileId: 'p1', rev: 3, keys: keys(1) })).toMatchObject({ ok: false, code: 'stale' });
    expect(await c.write(ORIGIN, { profileId: 'p1', rev: 5, keys: keys(5) })).toMatchObject({ ok: true, written: false });
    expect((await c.read(ORIGIN)).copy?.counts.logs).toBe(5);
  });
});

describe('a different browser profile', () => {
  it('does not replace the copy of a wiped profile unless told to, and then keeps the old one as a safety copy', async () => {
    const c = make();
    await c.write(ORIGIN, { profileId: 'old', rev: 40, keys: keys(40) });
    const fresh = await c.write(ORIGIN, { profileId: 'new', rev: 1, keys: keys(0) });
    expect(fresh).toMatchObject({ ok: false, code: 'other-profile', current: { profileId: 'old', rev: 40 } });
    expect((await c.read(ORIGIN)).copy?.counts.logs).toBe(40);

    clock += 1000;
    expect(await c.write(ORIGIN, { profileId: 'new', rev: 1, keys: keys(0), takeover: true })).toMatchObject({ ok: true });
    const safety = fs.readdirSync(path.join(root, originFolder(ORIGIN), 'safety'));
    expect(safety).toHaveLength(1);
    expect(parseCopyFile(fs.readFileSync(path.join(root, originFolder(ORIGIN), 'safety', safety[0]), 'utf8'))?.counts.logs).toBe(40);
  });
});

describe('damage', () => {
  it('falls back to prev.json when latest.json is damaged, and says so', async () => {
    const c = make();
    await c.write(ORIGIN, { profileId: 'p1', rev: 1, keys: keys(1) });
    await c.write(ORIGIN, { profileId: 'p1', rev: 2, keys: keys(2) });
    const latest = path.join(root, originFolder(ORIGIN), 'latest.json');
    fs.writeFileSync(latest, fs.readFileSync(latest, 'utf8').replace('l1', 'zz'));
    const r = await c.read(ORIGIN);
    expect(r.copy?.rev).toBe(1);
    expect(r.damaged).toBe(true);
  });

  it('reports nothing, not damage, when there is no copy yet', async () => {
    expect(await make().read(ORIGIN)).toEqual({ copy: null, damaged: false });
  });

  it('refuses a copy with nothing usable in it', async () => {
    expect(await make().write(ORIGIN, { profileId: 'p1', rev: 1, keys: {} })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('reports a disk failure in plain words and keeps the earlier copy', async () => {
    const c = make();
    await c.write(ORIGIN, { profileId: 'p1', rev: 1, keys: keys(1) });
    // A file where the "daily" folder should be makes the next write fail on disk.
    const daily = path.join(root, originFolder(ORIGIN), 'daily');
    fs.rmSync(daily, { recursive: true });
    fs.writeFileSync(daily, 'not a folder');
    const w = await c.write(ORIGIN, { profileId: 'p1', rev: 2, keys: keys(2) });
    expect(w).toMatchObject({ ok: false, code: 'disk' });
    expect((await c.read(ORIGIN)).copy?.rev).toBe(1);
  });
});

describe('safety copies and housekeeping', () => {
  it('keeps only the newest 10 safety copies', async () => {
    const c = make();
    for (let i = 0; i < 12; i++) {
      clock += 1000;
      await c.safety(ORIGIN, keys(1), 'Reset all');
    }
    expect(fs.readdirSync(path.join(root, originFolder(ORIGIN), 'safety'))).toHaveLength(10);
  });

  it('keeps the daily copies of the last 14 days only', async () => {
    const c = make();
    for (let i = 0; i < 16; i++) {
      clock += 24 * 3600 * 1000;
      await c.write(ORIGIN, { profileId: 'p1', rev: i + 1, keys: keys(1) });
    }
    expect(fs.readdirSync(path.join(root, originFolder(ORIGIN), 'daily'))).toHaveLength(14);
  });

  it('names the folder of an address safely', () => {
    expect(originFolder('localhost:38417')).toBe('localhost-38417');
    expect(originFolder('..\\evil/../x')).not.toMatch(/[\\/]/);
  });
});
