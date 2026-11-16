import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { localDayToUtcRange } from '../utils/activity/time';
import { clip, redactSecrets } from '../utils/activity/sanitize';
import type {
  ActivityItem,
  ActivitySource,
  ScanRequest,
  ScanResponse,
  SourceStatus,
} from '../utils/activity/types';

const execFileAsync = promisify(execFile);
const fsp = fs.promises;

const exists = (p: string): Promise<boolean> => fsp.access(p).then(() => true, () => false);

const TIMED_OUT = Symbol('timed out');
const FOLDER_STAT_TIMEOUT_MS = 5_000;

/** The promise's value, or TIMED_OUT when it has not settled after `ms`. The work itself is not cancelled. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a listed folder is there. A folder on a share that never answers is 'slow', not a hang for the whole scan. */
async function folderState(p: string, timeoutMs = FOLDER_STAT_TIMEOUT_MS): Promise<'dir' | 'missing' | 'slow'> {
  const r = await withTimeout(
    fsp.stat(p).then((s): 'dir' | 'missing' => (s.isDirectory() ? 'dir' : 'missing'), (): 'missing' => 'missing'),
    timeoutMs,
  );
  return r === TIMED_OUT ? 'slow' : r;
}

interface Range {
  startIso: string;
  endIso: string;
}

const TEXT_MAX = 200;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// --- folder matching -------------------------------------------------------------------------

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** True when `cwd` is `folder` or inside it. Case-insensitive, slash-agnostic, separator-bounded. */
export function isUnderFolder(cwd: string, folder: string): boolean {
  const c = norm(cwd);
  const f = norm(folder);
  return c === f || c.startsWith(`${f}/`);
}

/** The listed folder that contains `cwd`; when listed folders nest, the deepest one. */
export function deepestFolder(cwd: string, folders: string[]): string | null {
  let best: string | null = null;
  for (const f of folders) {
    if (isUnderFolder(cwd, f) && (best === null || norm(f).length > norm(best).length)) best = f;
  }
  return best;
}

const inRange = (iso: string, r: Range): boolean => {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= Date.parse(r.startIso) && t < Date.parse(r.endIso);
};

// --- Claude Code history -----------------------------------------------------------------------

// First meaningful line of a user message, or null when it is not something the user typed
// (system reminders, task notifications, command wrappers). A pasted prompt keeps the text
// inside its <pasted_content> wrapper.
function promptText(content: string): string | null {
  let text = content.trim();
  if (text.startsWith('<pasted_content')) text = text.replace(/^<pasted_content[^>]*>/, '').trim();
  else if (text.startsWith('<')) return null;
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return first ? clip(redactSecrets(first), TEXT_MAX) : null;
}

/**
 * Turns Claude Code session lines (JSONL) into activity items for the given day and folders.
 * Claude's file format is internal and can change, so every line is parsed defensively:
 * anything unexpected is skipped, never thrown.
 */
export async function parseClaudeLines(
  lines: AsyncIterable<string> | Iterable<string>,
  args: { folders: string[]; startIso: string; endIso: string },
): Promise<ActivityItem[]> {
  const items: ActivityItem[] = [];
  const titles = new Map<string, string>();
  const firstSeen = new Map<string, { time: string; folder: string }>();

  const note = (sessionId: string, time: string, folder: string) => {
    const seen = firstSeen.get(sessionId);
    if (!seen || time < seen.time) firstSeen.set(sessionId, { time, folder });
  };

  for await (const raw of lines) {
    let o: any;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;

    if (o.type === 'ai-title' && typeof o.sessionId === 'string' && typeof o.aiTitle === 'string') {
      titles.set(o.sessionId, o.aiTitle);
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain === true || o.isMeta === true) continue;
    if (typeof o.timestamp !== 'string' || typeof o.cwd !== 'string' || typeof o.sessionId !== 'string' || typeof o.uuid !== 'string') continue;
    if (!inRange(o.timestamp, args)) continue;
    const folder = deepestFolder(o.cwd, args.folders);
    if (!folder) continue;
    const time = new Date(o.timestamp).toISOString();

    if (o.type === 'user') {
      const content = o.message?.content;
      if (typeof content !== 'string') continue;
      const text = promptText(content);
      if (!text) continue;
      items.push({ id: `claude:${o.sessionId}:${o.uuid}`, source: 'claude', folder, time, text });
      note(o.sessionId, time, folder);
    } else if (Array.isArray(o.message?.content)) {
      let n = 0;
      for (const block of o.message.content) {
        if (block?.type !== 'tool_use' || !WRITE_TOOLS.has(block.name)) continue;
        const file = block.input?.file_path;
        if (typeof file !== 'string') continue;
        // Only the file's name is kept: never its contents.
        items.push({
          id: `claude:${o.sessionId}:${o.uuid}:${n++}`,
          source: 'claude',
          folder,
          time,
          text: clip(redactSecrets(`Edited ${path.win32.basename(file)}`), TEXT_MAX),
        });
        note(o.sessionId, time, folder);
      }
    }
  }

  for (const [sessionId, seen] of firstSeen) {
    const title = titles.get(sessionId);
    if (!title) continue;
    items.push({
      id: `claude:${sessionId}:title`,
      source: 'claude',
      folder: seen.folder,
      time: seen.time,
      text: clip(redactSecrets(`Session: ${title}`), TEXT_MAX),
    });
  }

  return items.sort((a, b) => a.time.localeCompare(b.time));
}

/** Reads this day's Claude Code activity for the listed folders from `<claudeDir>/projects`. */
export async function readClaudeHistory(
  folders: string[],
  range: Range,
  opts: { claudeDir?: string } = {},
): Promise<{ items: ActivityItem[]; status: SourceStatus }> {
  const projectsDir = path.join(opts.claudeDir ?? path.join(os.homedir(), '.claude'), 'projects');
  if (!(await exists(projectsDir))) {
    return { items: [], status: { ok: true, count: 0, note: 'No Claude Code history found on this computer' } };
  }
  const startMs = Date.parse(range.startIso);
  const items: ActivityItem[] = [];
  let unreadable = 0;
  try {
    // Async file calls, so a slow disk never freezes the server (it runs inside the desktop app's main process).
    for (const entry of await fsp.readdir(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(projectsDir, entry.name);
      // One unreadable project folder costs only its own sessions, not the whole source.
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        unreadable++;
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        try {
          // A session file not touched since before this day cannot hold activity from it.
          if ((await fsp.stat(file)).mtimeMs < startMs) continue;
          const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
          items.push(...(await parseClaudeLines(rl, { folders, ...range })));
        } catch {
          unreadable++;
        }
      }
    }
  } catch {
    return { items: [], status: { ok: false, count: 0, note: "Couldn't read Claude Code history" } };
  }
  items.sort((a, b) => a.time.localeCompare(b.time));
  return {
    items,
    status: {
      ok: true,
      count: items.length,
      note: unreadable > 0 ? `${unreadable} history file(s) could not be read` : undefined,
    },
  };
}

// --- git ---------------------------------------------------------------------------------------

const hasGit = (dir: string): Promise<boolean> => exists(path.join(dir, '.git'));

// Each listed folder itself (if it is a repo) plus its immediate child repos.
export async function findRepos(folders: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const repos: string[] = [];
  const add = (dir: string) => {
    const key = norm(dir);
    if (!seen.has(key)) {
      seen.add(key);
      repos.push(dir);
    }
  };
  for (const folder of folders) {
    if (await hasGit(folder)) add(folder);
    try {
      for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory() && (await hasGit(path.join(folder, entry.name)))) add(path.join(folder, entry.name));
      }
    } catch {
      // unreadable folder: nothing to add
    }
  }
  return repos;
}

const GIT_CONFIG_TIMEOUT_MS = 5_000;
const GIT_LOG_TIMEOUT_MS = 20_000;

/** Runs one git command in a repo. Rejects like child_process.execFile does (code, signal, killed, stderr). */
export type GitRunner = (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ stdout: string }>;

/**
 * What a failed git call means, in a plain sentence. `ignore` is for the cases that are not a problem
 * (a repo that has no commits yet). Never throws.
 */
export function describeGitFailure(err: unknown, repo: string): { note: string; ignore?: boolean } {
  const e = (err ?? {}) as { code?: unknown; killed?: boolean; signal?: string | null; stderr?: unknown; message?: unknown };
  const said = String(e.stderr || e.message || '');
  if (e.code === 'ENOENT') return { note: "Git is not installed or is not on this computer's PATH." };
  if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') return { note: `Git took too long in ${repo} and was stopped.` };
  if (/dubious ownership/i.test(said)) {
    return { note: `Git does not trust the folder ${repo}. To allow it, run: git config --global --add safe.directory "${repo.replace(/\\/g, '/')}"` };
  }
  if (/does not have any commits yet|bad default revision/i.test(said)) return { note: '', ignore: true };
  const first = said.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return { note: `Git could not read ${repo}${first ? `: ${clip(redactSecrets(first), TEXT_MAX)}` : ''}` };
}

/** Commits made today across the listed folders' repos (all branches), by the repo's git user. */
export async function readGitCommits(
  folders: string[],
  range: Range,
  opts: { env?: NodeJS.ProcessEnv; runGit?: GitRunner } = {},
): Promise<{ items: ActivityItem[]; status: SourceStatus }> {
  const env = opts.env ?? process.env;
  const runGit: GitRunner =
    opts.runGit ??
    ((args, o) => execFileAsync('git', args, { cwd: o.cwd, env, timeout: o.timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true }));
  const byId = new Map<string, ActivityItem>();
  const notes: string[] = [];
  const addNote = (n: string) => {
    if (n && !notes.includes(n)) notes.push(n);
  };
  let tried = 0;
  let failed = 0;

  for (const repo of await findRepos(folders)) {
    const folder = deepestFolder(repo, folders);
    if (!folder) continue;
    tried++;
    // Exit code 1 with no output is git's "not set". Any other failure here (git missing, hung, not trusted) is
    // reported by the log call below, so it is not mistaken for a missing user.name.
    let userName = '';
    let nameUnset = false;
    try {
      userName = (await runGit(['config', 'user.name'], { cwd: repo, timeoutMs: GIT_CONFIG_TIMEOUT_MS })).stdout.trim();
      nameUnset = !userName;
    } catch (err) {
      nameUnset = (err as { code?: unknown })?.code === 1 && !String((err as { stderr?: unknown }).stderr ?? '').trim();
    }
    if (nameUnset) addNote(`git user.name is not set in ${repo}: showing commits from all authors`);

    const args = [
      'log', '--all',
      `--since=${range.startIso}`, `--until=${range.endIso}`,
      '--pretty=format:%H%x1f%cI%x1f%s',
      ...(userName ? ['--fixed-strings', `--author=${userName}`] : []),
    ];
    let stdout = '';
    try {
      stdout = (await runGit(args, { cwd: repo, timeoutMs: GIT_LOG_TIMEOUT_MS })).stdout;
    } catch (err) {
      // A repo with no commits yet is empty, not broken. Anything else is said in plain words, and the
      // other repos are still read.
      const why = describeGitFailure(err, repo);
      if (!why.ignore) {
        failed++;
        addNote(why.note);
      }
      continue;
    }
    for (const row of stdout.split('\n')) {
      const [hash, iso, subject] = row.split('\x1f');
      if (!hash || !iso || subject === undefined) continue;
      const id = `git:${hash}`;
      if (byId.has(id)) continue;
      const time = new Date(iso);
      if (Number.isNaN(time.getTime())) continue;
      byId.set(id, { id, source: 'git', folder, time: time.toISOString(), text: clip(redactSecrets(subject), TEXT_MAX) });
    }
  }

  const items = [...byId.values()].sort((a, b) => a.time.localeCompare(b.time));
  const note = notes.length > 0 ? notes.slice(0, 3).join('. ') : undefined;
  // Not ok only when every repo that was tried failed: one broken repo must not hide the others' commits.
  return { items, status: { ok: !(tried > 0 && failed === tried), count: items.length, note } };
}

// --- one scan ---------------------------------------------------------------------------------

const OFF: SourceStatus = { ok: true, count: 0, note: 'Turned off in Settings' };

/** Reads every switched-on source for one local day. Throws a plain-sentence Error on a bad folder. */
export async function scanActivity(
  req: ScanRequest,
  opts: { claudeDir?: string; env?: NodeJS.ProcessEnv; runGit?: GitRunner; folderTimeoutMs?: number } = {},
): Promise<ScanResponse> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.date)) throw new Error('Pick a valid date.');
  // A malformed path is a bug in the request and is refused. A folder that is simply gone (deleted,
  // drive unplugged) must not cost the user the other folders' suggestions: it is skipped and reported.
  // A folder that does not answer (a network drive that went away) is skipped too, after a few seconds.
  for (const f of req.folders) {
    if (typeof f?.path !== 'string' || !path.isAbsolute(f.path)) {
      throw new Error(`Enter the full folder path, like E:\\projects\\app. (${String(f?.path)})`);
    }
  }
  const states = await Promise.all(req.folders.map((f) => folderState(f.path, opts.folderTimeoutMs)));
  const paths = req.folders.filter((_, i) => states[i] === 'dir').map((f) => f.path);
  const skipped = req.folders.filter((_, i) => states[i] === 'missing').map((f) => f.path);
  const slow = req.folders.filter((_, i) => states[i] === 'slow').map((f) => f.path);

  const range = localDayToUtcRange(req.date);
  const claude = req.sources.claude ? await readClaudeHistory(paths, range, { claudeDir: opts.claudeDir }) : { items: [], status: OFF };
  const git = req.sources.git ? await readGitCommits(paths, range, { env: opts.env, runGit: opts.runGit }) : { items: [], status: OFF };

  const status: Record<ActivitySource, SourceStatus> = { claude: claude.status, git: git.status };
  const folderNotes = [
    skipped.length > 0 ? `Folder not found, skipped: ${skipped.join(', ')}` : '',
    slow.length > 0 ? `Folder did not answer, skipped: ${slow.join(', ')}` : '',
  ].filter(Boolean);
  if (folderNotes.length > 0) {
    // Said once, on the first source that is switched on.
    const carrier = req.sources.git ? 'git' : req.sources.claude ? 'claude' : null;
    if (carrier) {
      status[carrier] = { ...status[carrier], note: [status[carrier].note, ...folderNotes].filter(Boolean).join('. ') };
    }
  }
  const items = [...claude.items, ...git.items].sort((a, b) => a.time.localeCompare(b.time));
  return { items, status };
}
