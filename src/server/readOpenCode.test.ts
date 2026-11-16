import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { readOpenCodeHistory } from './readOpenCode';

const RANGE = { startIso: '2026-11-15T18:00:00.000Z', endIso: '2026-11-16T18:00:00.000Z' };
const FOLDERS = ['E:\\Projects\\app'];
const T = Date.parse('2026-11-16T05:00:00Z');

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const newDb = (): { file: string; db: DatabaseSync } => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-oc-'));
  const file = path.join(dir, 'opencode.db');
  return { file, db: new DatabaseSync(file) };
};

describe('readOpenCodeHistory', () => {
  it('says plainly when there is no database', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-oc-'));
    const r = await readOpenCodeHistory(FOLDERS, RANGE, { dbPath: path.join(dir, 'none.db') });
    expect(r.status).toMatchObject({ ok: true, count: 0 });
    expect(r.status.note).toMatch(/No OpenCode history/);
  });

  it('reads v2 user prompts in a listed folder and ignores other rows', async () => {
    const { file, db } = newDb();
    db.exec('CREATE TABLE session_v2 (id TEXT, directory TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);');
    db.prepare('INSERT INTO session_v2 VALUES (?, ?)').run('s1', 'E:\\Projects\\app\\sub');
    db.prepare('INSERT INTO session_v2 VALUES (?, ?)').run('s2', 'C:\\Other');
    const ins = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
    ins.run('m1', 's1', 'user', T, JSON.stringify({ text: 'Fix the login bug\ndetails' }));
    ins.run('m2', 's1', 'assistant', T, JSON.stringify({ text: 'answer' }));
    ins.run('m3', 's2', 'user', T, JSON.stringify({ text: 'other folder' }));
    ins.run('m4', 's1', 'user', T - 10 * 86400000, JSON.stringify({ text: 'old' }));
    db.close();
    const r = await readOpenCodeHistory(FOLDERS, RANGE, { dbPath: file });
    expect(r.items).toEqual([{ id: 'opencode:s1:m1', source: 'opencode', folder: 'E:\\Projects\\app', time: new Date(T).toISOString(), text: 'Fix the login bug' }]);
    expect(r.status).toMatchObject({ ok: true, count: 1 });
  });

  it('reads v1 messages with their text part', async () => {
    const { file, db } = newDb();
    db.exec('CREATE TABLE session (id TEXT, directory TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, data TEXT);');
    db.prepare('INSERT INTO session VALUES (?, ?)').run('s1', 'E:\\Projects\\app');
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 's1', T, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 's1', T, JSON.stringify({ role: 'assistant' }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?)').run('p1', 'm1', JSON.stringify({ type: 'reasoning', text: 'x' }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?)').run('p2', 'm1', JSON.stringify({ type: 'text', text: 'Write the tests' }));
    db.close();
    const r = await readOpenCodeHistory(FOLDERS, RANGE, { dbPath: file });
    expect(r.items.map((i) => [i.id, i.text])).toEqual([['opencode:s1:m1', 'Write the tests']]);
  });

  it('reports a format it does not recognise instead of failing', async () => {
    const { file, db } = newDb();
    db.exec('CREATE TABLE unrelated (x TEXT)');
    db.close();
    const r = await readOpenCodeHistory(FOLDERS, RANGE, { dbPath: file });
    expect(r.status).toMatchObject({ ok: false });
    expect(r.status.note).toMatch(/does not recognise/);
  });
});
