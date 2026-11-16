import fs from 'fs';
import os from 'os';
import path from 'path';
import { clip, redactSecrets } from '../utils/activity/sanitize';
import type { ActivityItem, SourceStatus } from '../utils/activity/types';
import { deepestFolder } from './activityReaders';

// OpenCode history: a SQLite database (~/.local/share/opencode/opencode.db) opened read-only. It holds two
// generations of tables (see docs/superpowers/specs/2026-11-16-automatic-day-design.md): v1 `message` + `part`, and
// v2 `session_message`. Both are read when present; a missing table is not an error. Only the user's typed prompts are
// kept. node:sqlite is built into Node 22+ and Electron 39.

const TEXT_MAX = 200;

interface Range {
  startIso: string;
  endIso: string;
}

type Row = Record<string, unknown>;

function textOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const first = raw.trim().split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!first || first.startsWith('<')) return null;
  return clip(redactSecrets(first), TEXT_MAX);
}

const parseJson = (s: unknown): any => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

export async function readOpenCodeHistory(
  folders: string[],
  range: Range,
  opts: { dbPath?: string } = {},
): Promise<{ items: ActivityItem[]; status: SourceStatus }> {
  const dbPath = opts.dbPath ?? path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!fs.existsSync(dbPath)) return { items: [], status: { ok: true, count: 0, note: 'No OpenCode history found on this computer' } };

  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { items: [], status: { ok: false, count: 0, note: "This version of WorkPulse can't read OpenCode history" } };
  }

  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return { items: [], status: { ok: false, count: 0, note: "Couldn't open OpenCode history (is it locked?)" } };
  }

  const startMs = Date.parse(range.startIso);
  const endMs = Date.parse(range.endIso);
  const items: ActivityItem[] = [];
  let tablesRead = 0;
  const all = (sql: string, ...params: unknown[]): Row[] | null => {
    try {
      return db.prepare(sql).all(...params) as Row[];
    } catch {
      return null; // table or column missing: that generation is not here
    }
  };
  const add = (sessionId: unknown, messageId: unknown, ms: unknown, directory: unknown, text: string | null) => {
    if (!text || typeof sessionId !== 'string' || typeof messageId !== 'string' || typeof directory !== 'string' || typeof ms !== 'number') return;
    const folder = deepestFolder(directory, folders);
    if (!folder) return;
    items.push({ id: `opencode:${sessionId}:${messageId}`, source: 'opencode', folder, time: new Date(ms).toISOString(), text });
  };

  try {
    // v2: user prompts are session_message rows of type 'user'.
    const v2 = all(
      `SELECT m.id AS id, m.session_id AS sid, m.time_created AS t, m.data AS data, s.directory AS dir
         FROM session_message m JOIN session_v2 s ON s.id = m.session_id
        WHERE m.type = 'user' AND m.time_created >= ? AND m.time_created < ?`,
      startMs,
      endMs,
    );
    if (v2) {
      tablesRead++;
      for (const r of v2) add(r.sid, r.id, r.t, r.dir, textOf(parseJson(r.data)?.text));
    }

    // v1: user messages, with the text in their `part` rows.
    const v1 = all(
      `SELECT m.id AS id, m.session_id AS sid, m.time_created AS t, m.data AS data, s.directory AS dir
         FROM message m JOIN session s ON s.id = m.session_id
        WHERE m.time_created >= ? AND m.time_created < ?`,
      startMs,
      endMs,
    );
    if (v1) {
      tablesRead++;
      for (const r of v1) {
        if (parseJson(r.data)?.role !== 'user') continue;
        const parts = all('SELECT data FROM part WHERE message_id = ? ORDER BY id', r.id) ?? [];
        const text = parts.map((p) => parseJson(p.data)).find((d) => d?.type === 'text' && typeof d.text === 'string')?.text;
        add(r.sid, r.id, r.t, r.dir, textOf(text));
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // closing is best effort
    }
  }

  if (tablesRead === 0) return { items: [], status: { ok: false, count: 0, note: 'OpenCode history is in a format WorkPulse does not recognise' } };
  items.sort((a, b) => a.time.localeCompare(b.time));
  return { items, status: { ok: true, count: items.length } };
}
