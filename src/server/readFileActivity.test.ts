import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNoiseFile, readFileActivity } from './readFileActivity';

let root: string;
const DAY = { startIso: '2026-11-17T00:00:00.000Z', endIso: '2026-11-18T00:00:00.000Z' };
const at = (iso: string) => new Date(iso);

function put(rel: string, iso = '2026-11-17T05:10:00.000Z', body = 'x') {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  fs.utimesSync(full, at(iso), at(iso));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-files-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isNoiseFile', () => {
  it('flags temp, lock and system files', () => {
    for (const n of ['~$a.docx', 'x.tmp', 'x.swp', 'debug.log', 'package-lock.json', 'yarn.lock', 'Thumbs.db']) {
      expect(isNoiseFile(n)).toBe(true);
    }
    expect(isNoiseFile('app.ts')).toBe(false);
  });
});

describe('readFileActivity', () => {
  it('groups files per hour into one item with names only', async () => {
    put('a.ts');
    put('b.ts', '2026-11-17T05:40:00.000Z');
    put('c.ts', '2026-11-17T05:20:00.000Z');
    put('d.ts', '2026-11-17T05:30:00.000Z');
    put('late.ts', '2026-11-17T09:00:00.000Z');
    const r = await readFileActivity([root], DAY);
    expect(r.items).toHaveLength(2);
    const first = r.items[0];
    expect(first.text).toBe('Edited 4 files: a.ts, b.ts, c.ts, ...');
    expect(first.time).toBe('2026-11-17T05:40:00.000Z');
    expect(first.folder).toBe(root);
    expect(first.id).toMatch(/^file:2026-11-17:[0-9a-f]{10}:\d+$/);
    expect(r.items[1].text).toBe('Edited 1 file: late.ts');
    expect(r.status).toEqual({ ok: true, count: 2, note: undefined });
  });

  it('ignores other days, skipped folders and noise', async () => {
    put('old.ts', '2026-11-16T05:00:00.000Z');
    put('node_modules/x/y.js');
    put('.git/z');
    put('dist/o.js');
    put('~$doc.docx');
    put('a.tmp');
    put('package-lock.json');
    put('run.log');
    const r = await readFileActivity([root], DAY);
    expect(r.items).toEqual([]);
  });

  it('respects depth 5', async () => {
    put('1/2/3/4/5/ok.ts');
    put('1/2/3/4/5/6/deep.ts');
    const r = await readFileActivity([root], DAY);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].text).toContain('ok.ts');
  });

  it('uses the deepest linked folder', async () => {
    put('sub/a.ts');
    const sub = path.join(root, 'sub');
    const r = await readFileActivity([root, sub], DAY);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].folder).toBe(sub);
  });

  it('redacts secrets in names', async () => {
    put('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789.txt');
    const r = await readFileActivity([root], DAY);
    expect(r.items[0].text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('notes a cut walk when time runs out', async () => {
    put('a.ts');
    put('b.ts');
    let t = 0;
    const r = await readFileActivity([root], DAY, { now: () => (t += 5_000) });
    expect(r.status.note).toMatch(/part of/);
  });

  it('notes an unreadable folder', async () => {
    const r = await readFileActivity([path.join(root, 'missing')], DAY);
    expect(r.items).toEqual([]);
    expect(r.status.note).toContain('missing');
  });
});
