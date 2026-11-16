import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { clip, redactSecrets } from '../utils/activity/sanitize';
import type { ActivityItem, SourceStatus } from '../utils/activity/types';
import { deepestFolder } from './activityReaders';

// Documents worked on today (Word, Excel, PowerPoint, PDF, OpenDocument) inside the listed folders. Only the file
// name and its last-modified time are used: a document is never opened or read. The walk is bounded (depth, number of
// entries, time) so a huge folder cannot stall a scan.

const fsp = fs.promises;
const EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.odt', '.ods', '.odp']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'appdata', '$recycle.bin', 'system volume information']);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 5_000;
const MAX_MS = 3_000;
const TEXT_MAX = 200;

interface Range {
  startIso: string;
  endIso: string;
}

export async function readDocuments(
  folders: string[],
  range: Range,
  opts: { now?: () => number } = {},
): Promise<{ items: ActivityItem[]; status: SourceStatus }> {
  const now = opts.now ?? Date.now;
  const startMs = Date.parse(range.startIso);
  const endMs = Date.parse(range.endIso);
  const deadline = now() + MAX_MS;
  const items: ActivityItem[] = [];
  let seen = 0;
  let cut = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (cut) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
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
      if (!e.isFile() || e.name.startsWith('~$') || e.name.startsWith('.~') || !EXT.has(path.extname(e.name).toLowerCase())) continue;
      let ms: number;
      try {
        ms = (await fsp.stat(full)).mtimeMs;
      } catch {
        continue;
      }
      if (ms < startMs || ms >= endMs) continue;
      const folder = deepestFolder(full, folders);
      if (!folder) continue;
      const hash = createHash('sha1').update(full.toLowerCase()).digest('hex').slice(0, 10);
      items.push({
        id: `doc:${range.startIso.slice(0, 10)}:${hash}`,
        source: 'docs',
        folder,
        time: new Date(ms).toISOString(),
        text: clip(redactSecrets(`Edited ${e.name}`), TEXT_MAX),
      });
    }
  };

  for (const f of folders) await walk(f, 0);
  items.sort((a, b) => a.time.localeCompare(b.time));
  return {
    items,
    status: { ok: true, count: items.length, note: cut ? 'Looked through part of a large folder only' : undefined },
  };
}
