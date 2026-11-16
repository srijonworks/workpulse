import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePorcelainZ } from './gitChanges';
import { readDocuments } from './readDocuments';

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const touch = (file: string, iso: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  const t = new Date(iso);
  fs.utimesSync(file, t, t);
};

describe('readDocuments', () => {
  const range = { startIso: '2026-11-15T18:00:00.000Z', endIso: '2026-11-16T18:00:00.000Z' };

  it('lists document files changed in the day, by name and time only, skipping temp and system files', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-docs-'));
    touch(path.join(dir, 'Report.docx'), '2026-11-16T05:00:00Z');
    touch(path.join(dir, 'sub', 'Budget.xlsx'), '2026-11-16T06:00:00Z');
    touch(path.join(dir, '~$Report.docx'), '2026-11-16T05:00:00Z'); // Word's lock file
    touch(path.join(dir, 'old.pdf'), '2026-11-01T05:00:00Z');
    touch(path.join(dir, 'notes.txt'), '2026-11-16T05:00:00Z'); // not a document type
    touch(path.join(dir, 'node_modules', 'x', 'readme.pdf'), '2026-11-16T05:00:00Z');
    const r = await readDocuments([dir], range);
    expect(r.items.map((i) => [i.text, i.source, i.folder])).toEqual([
      ['Edited Report.docx', 'docs', dir],
      ['Edited Budget.xlsx', 'docs', dir],
    ]);
    expect(r.items[0].id).toMatch(/^doc:2026-11-15:[0-9a-f]{10}$/);
  });

  it('stops a walk that takes too long, and says so', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-docs-'));
    touch(path.join(dir, 'a.docx'), '2026-11-16T05:00:00Z');
    let t = 0;
    const r = await readDocuments([dir], range, { now: () => (t += 10_000) });
    expect(r.status.note).toMatch(/part of a large folder/);
  });
});

describe('parsePorcelainZ', () => {
  it('reads paths from git status -z output, including renames', () => {
    expect(parsePorcelainZ(' M src/a.ts\0?? new file.md\0R  new.ts\0old.ts\0A  b.ts\0')).toEqual(['src/a.ts', 'new file.md', 'new.ts', 'b.ts']);
    expect(parsePorcelainZ('')).toEqual([]);
  });
});
