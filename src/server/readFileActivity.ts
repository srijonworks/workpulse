import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { deepestFolder } from '../utils/activity/folderMatch';
import { clip, redactSecrets } from '../utils/activity/sanitize';
import type { ActivityItem, SourceStatus } from '../utils/activity/types';

// Files changed today inside the linked folders. Only file names and modified times are used: a file is never opened.
// The walk is bounded (depth, entries, time) so a huge folder cannot stall a scan.

const fsp = fs.promises;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'target', 'bin', 'obj', '__pycache__', 'venv', 'appdata',
  '$recycle.bin', 'system volume information',
]);
const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'cargo.lock', 'composer.lock', 'poetry.lock',
  'gemfile.lock', 'thumbs.db', 'desktop.ini', '.ds_store',
]);
const SKIP_EXT = new Set(['.tmp', '.swp', '.swo', '.log', '.lock', '.lck', '.crdownload', '.part']);
const MAX_DEPTH = 5;
const MAX_ENTRIES = 8_000;
const MAX_MS = 4_000;
const TEXT_MAX = 200;
const NAMES_SHOWN = 3;
const NAME_MAX = 40;

interface Range {
  startIso: string;
  endIso: string;
}

export function isNoiseFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (name.startsWith('~$') || name.startsWith('.~') || name.startsWith('#')) return true;
  if (name.endsWith('~')) return true;
  return SKIP_FILES.has(lower) || SKIP_EXT.has(path.extname(lower));
}

export async function readFileActivity(
  folders: string[],
  range: Range,
  opts: { now?: () => number } = {},
): Promise<{ items: ActivityItem[]; status: SourceStatus }> {
  const now = opts.now ?? Date.now;
  const startMs = Date.parse(range.startIso);
  const endMs = Date.parse(range.endIso);
  const deadline = now() + MAX_MS;
  const date = range.startIso.slice(0, 10);
  const buckets = new Map<string, { folder: string; bucket: number; latest: number; names: Set<string> }>();
  let seen = 0;
  let cut = false;
  const unreadable: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (cut) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      if (depth === 0) unreadable.push(path.basename(dir) || dir);
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES || now() > deadline) {
        cut = true;
        return;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || isNoiseFile(e.name)) continue;
      let ms: number;
      try {
        ms = (await fsp.stat(full)).mtimeMs;
      } catch {
        continue;
      }
      if (ms < startMs || ms >= endMs) continue;
      const folder = deepestFolder(full, folders);
      if (!folder) continue;
      const bucket = Math.floor(ms / 3_600_000);
      const key = `${folder}\u0000${bucket}`;
      let b = buckets.get(key);
      if (!b) {
        b = { folder, bucket, latest: ms, names: new Set() };
        buckets.set(key, b);
      }
      b.latest = Math.max(b.latest, ms);
      b.names.add(e.name);
    }
  };

  for (const f of folders) await walk(f, 0);

  const items: ActivityItem[] = [];
  for (const b of buckets.values()) {
    const names = [...b.names].sort();
    const shown = names.slice(0, NAMES_SHOWN).map((n) => clip(n, NAME_MAX));
    const more = names.length > shown.length ? ', ...' : '';
    const label = `Edited ${names.length} file${names.length === 1 ? '' : 's'}: ${shown.join(', ')}${more}`;
    const hash = createHash('sha1').update(b.folder.toLowerCase()).digest('hex').slice(0, 10);
    items.push({
      id: `file:${date}:${hash}:${b.bucket}`,
      source: 'files' as ActivityItem['source'],
      folder: b.folder,
      time: new Date(b.latest).toISOString(),
      text: clip(redactSecrets(label), TEXT_MAX),
    });
  }
  items.sort((a, b) => a.time.localeCompare(b.time));

  const notes: string[] = [];
  if (cut) notes.push('Looked through part of a large or slow folder only');
  if (unreadable.length) notes.push(`Could not read ${unreadable.join(', ')}`);
  return { items, status: { ok: true, count: items.length, note: notes.length ? notes.join('. ') : undefined } };
}
