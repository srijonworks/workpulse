import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { clip, redactSecrets } from '../utils/activity/sanitize';
import type { ActivityItem, SourceStatus } from '../utils/activity/types';
import { deepestFolder } from './activityReaders';

// Codex CLI history: one JSONL file per session under ~/.codex/sessions/YYYY/MM/DD/ (format recorded in
// docs/superpowers/specs/2026-11-16-automatic-day-design.md). The format is internal to Codex and can change, so every
// line is parsed defensively: anything unexpected is skipped, never thrown. Only the user's typed prompts are kept
// (never the model's answers or tool output).

const fsp = fs.promises;
const TEXT_MAX = 200;
const DAY_MS = 24 * 3600 * 1000;

interface Range {
  startIso: string;
  endIso: string;
}

const inRange = (iso: string, r: Range): boolean => {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= Date.parse(r.startIso) && t < Date.parse(r.endIso);
};

/** The first meaningful line of what the user typed, or null for injected context (instructions, environment). */
function promptText(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.startsWith('<') || /^#\s*AGENTS\.md instructions/i.test(text)) return null;
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return first ? clip(redactSecrets(first), TEXT_MAX) : null;
}

export async function parseCodexLines(
  lines: AsyncIterable<string> | Iterable<string>,
  args: { folders: string[]; startIso: string; endIso: string; sessionId: string },
): Promise<ActivityItem[]> {
  let cwd: string | null = null;
  let sessionId = args.sessionId;
  const prompts: { time: string; ordinal: string; text: string }[] = [];
  let n = 0;

  for await (const raw of lines) {
    n++;
    let o: any;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const p = o.payload;
    if ((o.type === 'session_meta' || o.type === 'turn_context') && p && typeof p === 'object') {
      if (cwd === null && typeof p.cwd === 'string') cwd = p.cwd;
      if (o.type === 'session_meta' && typeof p.id === 'string') sessionId = p.id;
      continue;
    }
    if (o.type !== 'response_item' || !p || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) continue;
    if (typeof o.timestamp !== 'string' || !inRange(o.timestamp, args)) continue;
    const joined = p.content.map((c: any) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
    const text = promptText(joined);
    if (!text) continue;
    prompts.push({ time: new Date(o.timestamp).toISOString(), ordinal: String(typeof o.ordinal === 'number' ? o.ordinal : n), text });
  }

  const folder = cwd ? deepestFolder(cwd, args.folders) : null;
  if (!folder) return [];
  return prompts.map((q) => ({ id: `codex:${sessionId}:${q.ordinal}`, source: 'codex' as const, folder, time: q.time, text: q.text }));
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayDir = (root: string, ms: number): string => {
  const d = new Date(ms);
  return path.join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()));
};

/** Reads this day's Codex prompts for the listed folders from `<codexDir>/sessions`. */
export async function readCodexHistory(
  folders: string[],
  range: Range,
  opts: { codexDir?: string } = {},
): Promise<{ items: ActivityItem[]; status: SourceStatus }> {
  const root = path.join(opts.codexDir ?? path.join(os.homedir(), '.codex'), 'sessions');
  try {
    await fsp.access(root);
  } catch {
    return { items: [], status: { ok: true, count: 0, note: 'No Codex history found on this computer' } };
  }
  const startMs = Date.parse(range.startIso);
  const endMs = Date.parse(range.endIso);
  // Date folders are in UTC; the local day can start on the day before.
  const dirs = new Set<string>();
  for (let t = startMs - DAY_MS; t <= endMs; t += DAY_MS) dirs.add(dayDir(root, t));
  dirs.add(dayDir(root, endMs));

  const items: ActivityItem[] = [];
  let unreadable = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue; // no sessions that day
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        if ((await fsp.stat(file)).mtimeMs < startMs) continue;
        const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
        items.push(...(await parseCodexLines(rl, { folders, ...range, sessionId: name.replace(/\.jsonl$/, '') })));
      } catch {
        unreadable++;
      }
    }
  }
  items.sort((a, b) => a.time.localeCompare(b.time));
  return { items, status: { ok: true, count: items.length, note: unreadable > 0 ? `${unreadable} Codex file(s) could not be read` : undefined } };
}
