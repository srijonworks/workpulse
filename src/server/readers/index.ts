/**
 * Maps each registered activity source (src/utils/activity/registry.ts) to the function that reads it.
 * To add a source: write its read function, add one line to READERS. `Record<ActivitySource, ...>` makes a
 * missing line a type error.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readClaudeHistory, readGitCommits, type GitRunner } from '../activityReaders';
import { readGitChanges } from '../gitChanges';
import { readCodexHistory } from '../readCodex';
import { readOpenCodeHistory } from '../readOpenCode';
import { readDocuments } from '../readDocuments';
import { readFileActivity } from '../readFileActivity';
import type { ActivityItem, ActivitySource, SourceStatus } from '../../utils/activity/types';

const execFileAsync = promisify(execFile);

export interface ReadContext {
  /** Listed folders that exist. */
  paths: string[];
  range: { startIso: string; endIso: string };
  opts: { claudeDir?: string; codexDir?: string; openCodeDb?: string; env?: NodeJS.ProcessEnv; runGit?: GitRunner };
}

export type ReadResult = { items: ActivityItem[]; status: SourceStatus };

export interface ServerReader {
  read: (ctx: ReadContext) => Promise<ReadResult>;
  /** Plain sentence for the status when `read` throws: one source failing never costs the others. */
  failNote: string;
}

export const READERS: Record<ActivitySource, ServerReader> = {
  claude: { failNote: "Couldn't read Claude Code history", read: (c) => readClaudeHistory(c.paths, c.range, { claudeDir: c.opts.claudeDir }) },
  git: { failNote: "Couldn't read git history", read: readGit },
  opencode: { failNote: "Couldn't read OpenCode history", read: (c) => readOpenCodeHistory(c.paths, c.range, { dbPath: c.opts.openCodeDb }) },
  codex: { failNote: "Couldn't read Codex history", read: (c) => readCodexHistory(c.paths, c.range, { codexDir: c.opts.codexDir }) },
  files: { failNote: "Couldn't look at the files you changed", read: (c) => readFileActivity(c.paths, c.range) },
  docs: { failNote: "Couldn't look through the folders for documents", read: (c) => readDocuments(c.paths, c.range) },
};

/** Commits, plus work not committed yet (a failure there never hides the commits). */
async function readGit(c: ReadContext): Promise<ReadResult> {
  const git = await readGitCommits(c.paths, c.range, { env: c.opts.env, runGit: c.opts.runGit });
  const runGit: GitRunner =
    c.opts.runGit ??
    ((args, o) => execFileAsync('git', args, { cwd: o.cwd, env: c.opts.env ?? process.env, timeout: o.timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true }));
  try {
    const wip = await readGitChanges(c.paths, c.range, runGit);
    const items = [...git.items, ...wip.items];
    return { items, status: { ...git.status, count: items.length } };
  } catch {
    return git;
  }
}
