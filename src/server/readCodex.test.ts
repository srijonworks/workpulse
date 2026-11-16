import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCodexLines, readCodexHistory } from './readCodex';

const RANGE = { startIso: '2026-11-15T18:00:00.000Z', endIso: '2026-11-16T18:00:00.000Z' };
const FOLDERS = ['E:\\Projects\\app'];
const line = (o: unknown) => JSON.stringify(o);
const user = (timestamp: string, ordinal: number, text: string) =>
  line({ timestamp, ordinal, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const meta = (cwd: string) => line({ timestamp: '2026-11-16T04:00:00Z', ordinal: 0, type: 'session_meta', payload: { id: 'sess-1', cwd } });

describe('parseCodexLines', () => {
  const args = { folders: FOLDERS, ...RANGE, sessionId: 'file-id' };

  it('keeps typed prompts of the day, in the listed folder, with the session id from the file', async () => {
    const items = await parseCodexLines([meta('E:\\Projects\\app\\src'), user('2026-11-16T05:00:00Z', 3, 'Add the export button\nmore detail')], args);
    expect(items).toEqual([{ id: 'codex:sess-1:3', source: 'codex', folder: 'E:\\Projects\\app', time: '2026-11-16T05:00:00.000Z', text: 'Add the export button' }]);
  });

  it('skips injected context, other roles, other days, junk lines and unknown folders', async () => {
    const lines = [
      '{not json',
      meta('E:\\Projects\\app'),
      user('2026-11-16T05:00:00Z', 1, '<environment_context>x</environment_context>'),
      user('2026-11-16T05:01:00Z', 2, '# AGENTS.md instructions for E:\\Projects\\app'),
      user('2026-11-10T05:00:00Z', 3, 'too old'),
      line({ timestamp: '2026-11-16T05:02:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'answer' }] } }),
      user('2026-11-16T05:03:00Z', 5, 'real one'),
    ];
    const items = await parseCodexLines(lines, args);
    expect(items.map((i) => i.text)).toEqual(['real one']);
    expect(await parseCodexLines([meta('C:\\Other'), user('2026-11-16T05:03:00Z', 5, 'x')], args)).toEqual([]);
  });
});

describe('readCodexHistory', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the date folders around the day, and says plainly when there is no history', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-codex-'));
    expect((await readCodexHistory(FOLDERS, RANGE, { codexDir: dir })).status.note).toMatch(/No Codex history/);
    const day = path.join(dir, 'sessions', '2026', '11', '16');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), [meta('E:\\Projects\\app'), user('2026-11-16T05:00:00Z', 1, 'hello')].join('\n'));
    const r = await readCodexHistory(FOLDERS, RANGE, { codexDir: dir });
    expect(r.items.map((i) => i.text)).toEqual(['hello']);
    expect(r.status).toMatchObject({ ok: true, count: 1 });
  });
});
