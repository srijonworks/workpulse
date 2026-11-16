import type { AppSettings } from '../../types';
import { isUnderFolder } from './folderMatch';
import type { ActivityFolder, ActivityItem } from './types';

// Projects made on their own from the folders the user works in. A folder becomes a project only after real work was
// seen in it today (a commit or uncommitted change, a document, or at least two AI prompts), never just for existing.
// Pure: the hook (src/hooks/useAutoProjects.ts) does the scanning and creating.

/** Automatic projects are on unless switched off. */
export const autoProjectsEnabled = (s: Pick<AppSettings, 'activityAutoProjects'>): boolean => s.activityAutoProjects !== false;

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * The folder that holds the user's projects: the one set in Settings, else the folder that contains all the linked
 * project folders (their common parent, one level up). Null when there is nothing to go on.
 */
export function watchFolderOf(s: Pick<AppSettings, 'activityWatchFolder' | 'activityFolders'>): string | null {
  const set = s.activityWatchFolder?.trim();
  if (set) return set;
  const linked = s.activityFolders ?? [];
  if (linked.length === 0) return null;
  const parents = new Set(linked.map((f) => norm(f.path).replace(/\/[^/]+$/, '').toLowerCase()));
  if (parents.size !== 1) return null;
  const first = norm(linked[0].path);
  const cut = first.lastIndexOf('/');
  return cut > 2 ? linked[0].path.slice(0, cut).replace(/\//g, '\\') : null;
}

/** The repos that are not covered by a linked folder or the ignored list. */
export function unlinkedRepos(repos: string[], linked: ActivityFolder[], ignored: string[] = []): string[] {
  return repos.filter((r) => !linked.some((f) => isUnderFolder(r, f.path)) && !ignored.some((i) => isUnderFolder(r, i)));
}

const PROMPT_SOURCES = new Set(['claude', 'opencode', 'codex']);

/** The folders (of those scanned) where real work was seen. */
export function foldersWithRealWork(items: ActivityItem[]): string[] {
  const prompts = new Map<string, number>();
  const real = new Set<string>();
  for (const i of items) {
    if (i.source === 'git' || i.source === 'docs') real.add(i.folder);
    else if (PROMPT_SOURCES.has(i.source) && !i.text.startsWith('Session: ') && !i.text.startsWith('Edited ')) {
      prompts.set(i.folder, (prompts.get(i.folder) ?? 0) + 1);
    }
  }
  for (const [folder, n] of prompts) if (n >= 2) real.add(folder);
  return [...real];
}
