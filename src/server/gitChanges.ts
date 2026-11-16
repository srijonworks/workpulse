import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { clip, redactSecrets } from '../utils/activity/sanitize';
import type { ActivityItem } from '../utils/activity/types';
import { deepestFolder, describeGitFailure, findRepos, type GitRunner } from './activityReaders';

// Work that is not committed yet: the files git reports as changed or new, whose last-modified time falls in the day.
// One item per repo ("Uncommitted changes in 3 files: a.ts, b.ts, c.ts"). Only file names and times are used, never
// contents. The id is the repo and the day, so it stays the same while the files change and is not suggested again
// once it has been logged.

const MAX_FILES = 200;
const NAMES_SHOWN = 5;
const GIT_STATUS_TIMEOUT_MS = 15_000;
const TEXT_MAX = 200;

interface Range {
  startIso: string;
  endIso: string;
}

/** The paths in `git status --porcelain -z` output (rename entries carry the old path as a separate field, which is skipped). */
export function parsePorcelainZ(out: string): string[] {
  const files: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    files.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++; // skip the original path
  }
  return files;
}

export async function readGitChanges(
  folders: string[],
  range: Range,
  runGit: GitRunner,
): Promise<{ items: ActivityItem[]; notes: string[] }> {
  const startMs = Date.parse(range.startIso);
  const endMs = Date.parse(range.endIso);
  const items: ActivityItem[] = [];
  const notes: string[] = [];

  for (const repo of await findRepos(folders)) {
    const folder = deepestFolder(repo, folders);
    if (!folder) continue;
    let stdout = '';
    try {
      stdout = (await runGit(['status', '--porcelain', '-z', '--no-optional-locks'], { cwd: repo, timeoutMs: GIT_STATUS_TIMEOUT_MS })).stdout;
    } catch (err) {
      const why = describeGitFailure(err, repo);
      if (!why.ignore && why.note && !notes.includes(why.note)) notes.push(why.note);
      continue;
    }
    const touched: { name: string; ms: number }[] = [];
    for (const rel of parsePorcelainZ(stdout).slice(0, MAX_FILES)) {
      try {
        const ms = fs.statSync(path.join(repo, rel)).mtimeMs;
        if (ms >= startMs && ms < endMs) touched.push({ name: path.basename(rel), ms });
      } catch {
        // a deleted file has no time: it is skipped
      }
    }
    if (touched.length === 0) continue;
    touched.sort((a, b) => b.ms - a.ms);
    const names = [...new Set(touched.map((t) => t.name))];
    const shown = names.slice(0, NAMES_SHOWN).join(', ') + (names.length > NAMES_SHOWN ? ', …' : '');
    const hash = createHash('sha1').update(repo.toLowerCase()).digest('hex').slice(0, 10);
    items.push({
      id: `wip:${range.startIso.slice(0, 10)}:${hash}`,
      source: 'git',
      folder,
      time: new Date(touched[0].ms).toISOString(),
      text: clip(redactSecrets(`Uncommitted changes in ${touched.length} file${touched.length === 1 ? '' : 's'}: ${shown}`), TEXT_MAX),
    });
  }
  return { items, notes };
}
