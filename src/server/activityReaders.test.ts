process.env.TZ = 'Asia/Dhaka';

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  isUnderFolder,
  deepestFolder,
  describeGitFailure,
  parseClaudeLines,
  readClaudeHistory,
  readGitCommits,
  scanActivity,
  type GitRunner,
} from './activityReaders';
import { localDayToUtcRange } from '../utils/activity/time';

const range = localDayToUtcRange('2026-11-09'); // 2026-11-08T18:00Z .. 2026-11-09T18:00Z
const IN = '2026-11-09T04:00:00.000Z';
const IN2 = '2026-11-09T04:10:00.000Z';
const OUT = '2026-11-07T04:00:00.000Z';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-activity-'));
const line = (o: object) => JSON.stringify(o);

afterEach(() => vi.restoreAllMocks());

describe('isUnderFolder / deepestFolder', () => {
  it('matches the folder itself and its children', () => {
    expect(isUnderFolder('E:\\workpulse\\src', 'E:\\workpulse')).toBe(true);
    expect(isUnderFolder('E:\\workpulse', 'E:\\workpulse')).toBe(true);
  });
  it('needs a path separator boundary: E:\\work does not match E:\\workpulse', () => {
    expect(isUnderFolder('E:\\workpulse', 'E:\\work')).toBe(false);
  });
  it('ignores case, slash style and a trailing slash', () => {
    expect(isUnderFolder('e:/WorkPulse/', 'E:\\workpulse')).toBe(true);
  });
  it('picks the deepest of nested listed folders', () => {
    expect(deepestFolder('E:\\p\\app\\src', ['E:\\p', 'E:\\p\\app'])).toBe('E:\\p\\app');
    expect(deepestFolder('D:\\other', ['E:\\p'])).toBeNull();
  });
});

describe('parseClaudeLines', () => {
  const folders = ['E:\\workpulse'];
  const base = { sessionId: 's1', cwd: 'E:\\workpulse', isSidechain: false };
  const args = { folders, startIso: range.startIso, endIso: range.endIso };

  const fixture = [
    line({ ...base, type: 'user', uuid: 'u1', timestamp: IN, message: { content: 'Fix the timer bug\nmore detail' } }),
    line({ ...base, type: 'user', uuid: 'u2', timestamp: IN, message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    line({ ...base, type: 'user', uuid: 'u3', timestamp: IN, message: { content: '<system-reminder>hi</system-reminder>' } }),
    line({ ...base, type: 'user', uuid: 'u4', timestamp: IN, message: { content: '\n\n<pasted_content id="1">\nBuild the export feature\nrest\n</pasted_content>' } }),
    line({ ...base, type: 'user', uuid: 'u5', timestamp: OUT, message: { content: 'old prompt' } }),
    line({ ...base, cwd: 'E:\\elsewhere', type: 'user', uuid: 'u6', timestamp: IN, message: { content: 'other project' } }),
    line({ ...base, type: 'user', uuid: 'u7', timestamp: IN, message: { content: 'token AIzaSyA1234567890abcdefghijklmnopqrstuv9 here' } }),
    line({ ...base, isSidechain: true, type: 'user', uuid: 'u8', timestamp: IN, message: { content: 'subagent prompt' } }),
    line({
      ...base, type: 'assistant', uuid: 'a1', timestamp: IN2,
      message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Write', input: { file_path: 'E:\\workpulse\\src\\App.tsx', content: 'SECRET FILE BODY' } }] },
    }),
    line({ type: 'ai-title', aiTitle: 'Timer work', sessionId: 's1' }),
    line({ type: 'ai-title', aiTitle: 'Unrelated', sessionId: 'nope' }),
    '{this is not json',
    line({ type: 'mystery', foo: 1 }),
    '{"type":"user","uuid":"trunc',
  ];

  it('keeps only real in-range prompts, edited file names and the session title', async () => {
    const items = await parseClaudeLines(fixture, args);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual([
      'claude:s1:a1:0',
      'claude:s1:title',
      'claude:s1:u1',
      'claude:s1:u4',
      'claude:s1:u7',
    ]);
    expect(byId['claude:s1:u1'].text).toBe('Fix the timer bug');
    expect(byId['claude:s1:u4'].text).toBe('Build the export feature');
    expect(byId['claude:s1:a1:0'].text).toBe('Edited App.tsx');
    expect(byId['claude:s1:title'].text).toBe('Session: Timer work');
    expect(byId['claude:s1:u1'].folder).toBe('E:\\workpulse');
    expect(byId['claude:s1:u1'].source).toBe('claude');
  });
  it('redacts secrets and never carries file contents', async () => {
    const items = await parseClaudeLines(fixture, args);
    const all = JSON.stringify(items);
    expect(all).not.toContain('AIzaSyA1234567890');
    expect(all).not.toContain('SECRET FILE BODY');
  });
  it('accepts an async iterable of lines', async () => {
    async function* gen() {
      for (const l of fixture) yield l;
    }
    const items = await parseClaudeLines(gen(), args);
    expect(items.map((i) => i.id)).toContain('claude:s1:u1');
  });
  it('omits the session title when the session has nothing in range', async () => {
    const items = await parseClaudeLines([line({ ...base, type: 'user', uuid: 'u5', timestamp: OUT, message: { content: 'old' } }), line({ type: 'ai-title', aiTitle: 'T', sessionId: 's1' })], args);
    expect(items).toEqual([]);
  });
});

describe('readClaudeHistory', () => {
  const folders = ['E:\\workpulse'];
  const content = line({ type: 'user', uuid: 'u1', sessionId: 's1', cwd: 'E:\\workpulse', timestamp: IN, message: { content: 'Do the thing' } }) + '\n';

  const setup = (mtime: Date) => {
    const claudeDir = tmp();
    const dir = path.join(claudeDir, 'projects', 'E--workpulse');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    fs.writeFileSync(file, content);
    fs.utimesSync(file, mtime, mtime);
    return { claudeDir, file };
  };

  it('reads a recently modified file', async () => {
    const { claudeDir } = setup(new Date());
    const r = await readClaudeHistory(folders, range, { claudeDir });
    expect(r.items.map((i) => i.id)).toEqual(['claude:s1:u1']);
    expect(r.status).toMatchObject({ ok: true, count: 1 });
  });
  it('never opens a file last modified before the day starts', async () => {
    const { claudeDir, file } = setup(new Date('2026-11-01T00:00:00Z'));
    const spy = vi.spyOn(fs, 'createReadStream');
    const r = await readClaudeHistory(folders, range, { claudeDir });
    expect(r.items).toEqual([]);
    expect(spy.mock.calls.some((c) => String(c[0]) === file)).toBe(false);
  });
  it('streams files instead of reading them whole', async () => {
    const { claudeDir, file } = setup(new Date());
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const streamSpy = vi.spyOn(fs, 'createReadStream');
    await readClaudeHistory(folders, range, { claudeDir });
    expect(streamSpy.mock.calls.some((c) => String(c[0]) === file)).toBe(true);
    expect(readSpy.mock.calls.some((c) => String(c[0]) === file)).toBe(false);
  });
  it('reports a missing history folder as ok with no items', async () => {
    const r = await readClaudeHistory(folders, range, { claudeDir: tmp() });
    expect(r.items).toEqual([]);
    expect(r.status.ok).toBe(true);
  });
  it('loses only one project folder when it cannot be listed, and says so', async () => {
    const { claudeDir } = setup(new Date());
    const broken = path.join(claudeDir, 'projects', 'broken');
    fs.mkdirSync(broken);
    const realReaddir = fs.promises.readdir;
    vi.spyOn(fs.promises, 'readdir').mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p) === broken
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (realReaddir as (...a: unknown[]) => unknown)(p, ...rest)) as never);
    const r = await readClaudeHistory(folders, range, { claudeDir });
    expect(r.items.map((i) => i.id)).toEqual(['claude:s1:u1']);
    expect(r.status.ok).toBe(true);
    expect(r.status.note).toMatch(/1 history file\(s\) could not be read/);
  });
});

// --- git ---------------------------------------------------------------------------------
const emptyConfig = path.join(tmp(), 'empty-gitconfig');
fs.writeFileSync(emptyConfig, '');
const isolatedEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  ...extra,
});
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = isolatedEnv()) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const commit = (cwd: string, msg: string, iso: string, author = 'Tester') => {
  fs.writeFileSync(path.join(cwd, `${Math.random()}.txt`), msg);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', msg], isolatedEnv({
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: 'a@x.io', GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: 'a@x.io',
    GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso,
  }));
};
const repo = (): string => {
  const dir = tmp();
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
};

describe('readGitCommits', () => {
  it('returns only commits inside the local day, as git:<hash>', async () => {
    const dir = repo();
    commit(dir, 'old work', '2026-11-07T10:00:00+06:00');
    commit(dir, 'new work', '2026-11-09T10:00:00+06:00');
    const r = await readGitCommits([dir], range, { env: isolatedEnv() });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ source: 'git', text: 'new work', folder: dir });
    expect(r.items[0].id).toMatch(/^git:[0-9a-f]{40}$/);
    expect(r.items[0].time).toBe('2026-11-09T04:00:00.000Z');
  });
  it('includes commits on other branches (--all)', async () => {
    const dir = repo();
    commit(dir, 'on main', '2026-11-09T09:00:00+06:00');
    git(dir, ['checkout', '-q', '-b', 'feature']);
    commit(dir, 'on feature', '2026-11-09T11:00:00+06:00');
    git(dir, ['checkout', '-q', 'main']);
    const r = await readGitCommits([dir], range, { env: isolatedEnv() });
    expect(r.items.map((i) => i.text).sort()).toEqual(['on feature', 'on main']);
  });
  it('lists a repo once when it is reachable through a listed parent and a listed child', async () => {
    const parent = tmp();
    const child = path.join(parent, 'app');
    fs.mkdirSync(child);
    git(child, ['init', '-q', '-b', 'main']);
    commit(child, 'only once', '2026-11-09T10:00:00+06:00');
    const r = await readGitCommits([parent, child], range, { env: isolatedEnv() });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].folder).toBe(child);
  });
  it('filters by the repo user.name when it is set', async () => {
    const dir = repo();
    git(dir, ['config', 'user.name', 'Alice']);
    commit(dir, 'by alice', '2026-11-09T10:00:00+06:00', 'Alice');
    commit(dir, 'by bob', '2026-11-09T10:30:00+06:00', 'Bob');
    const r = await readGitCommits([dir], range, { env: isolatedEnv() });
    expect(r.items.map((i) => i.text)).toEqual(['by alice']);
    expect(r.status.note).toBeUndefined();
  });
  it('shows all authors with a note when user.name is not set', async () => {
    const dir = repo();
    commit(dir, 'by alice', '2026-11-09T10:00:00+06:00', 'Alice');
    commit(dir, 'by bob', '2026-11-09T10:30:00+06:00', 'Bob');
    const r = await readGitCommits([dir], range, { env: isolatedEnv() });
    expect(r.items).toHaveLength(2);
    expect(r.status.note).toContain('user.name is not set');
  });
  it('treats a folder that is not a repo as ok with no items', async () => {
    const r = await readGitCommits([tmp()], range, { env: isolatedEnv() });
    expect(r.items).toEqual([]);
    expect(r.status.ok).toBe(true);
  });
});

// --- git failures, with git itself replaced by a fake ----------------------------------------------
describe('describeGitFailure', () => {
  const REPO = 'E:\\Projects\\app';
  it('says git is missing', () => {
    expect(describeGitFailure(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), REPO).note).toMatch(/not installed or is not on this computer's PATH/);
  });
  it('says git took too long when it was stopped by the timeout', () => {
    const note = describeGitFailure(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }), REPO).note;
    expect(note).toContain('took too long');
    expect(note).toContain(REPO);
  });
  it('gives the safe.directory command for "dubious ownership"', () => {
    const err = Object.assign(new Error('Command failed'), { code: 128, stderr: "fatal: detected dubious ownership in repository at 'E:/Projects/app'\n" });
    const note = describeGitFailure(err, REPO).note;
    expect(note).toContain('git config --global --add safe.directory "E:/Projects/app"');
  });
  it('ignores a repo that has no commits yet', () => {
    const r = describeGitFailure(Object.assign(new Error('x'), { code: 128, stderr: "fatal: your current branch 'main' does not have any commits yet" }), REPO);
    expect(r.ignore).toBe(true);
  });
  it('keeps only the first line of anything else, with secrets redacted', () => {
    const note = describeGitFailure(Object.assign(new Error('x'), { code: 2, stderr: 'fatal: bad thing ghp_abcdefghijklmnopqrstuvwxyz0123456789ab\nsecond line' }), REPO).note;
    expect(note).toContain('fatal: bad thing');
    expect(note).not.toContain('second line');
    expect(note).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789ab');
  });
});

describe('readGitCommits when git fails', () => {
  // Folders that look like repos (a .git folder is enough: nothing runs git for real here).
  const fakeRepo = (parent = tmp(), name = 'app'): string => {
    const dir = path.join(parent, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
  };
  const failing = (err: unknown): GitRunner => async () => {
    throw err;
  };

  it('reports git as not installed (not ok) when every repo fails because of it', async () => {
    const dir = fakeRepo();
    const r = await readGitCommits([dir], range, { runGit: failing(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })) });
    expect(r.items).toEqual([]);
    expect(r.status.ok).toBe(false);
    expect(r.status.note).toMatch(/not installed/);
    expect(r.status.note).not.toMatch(/user\.name is not set/);
  });
  it('reports a git that hangs, and passes a timeout to every git call', async () => {
    const dir = fakeRepo();
    const calls: { args: string[]; timeoutMs: number }[] = [];
    const runGit: GitRunner = async (args, o) => {
      calls.push({ args, timeoutMs: o.timeoutMs });
      throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null });
    };
    const r = await readGitCommits([dir], range, { runGit });
    expect(r.status.ok).toBe(false);
    expect(r.status.note).toMatch(/took too long/);
    const config = calls.find((c) => c.args[0] === 'config');
    const log = calls.find((c) => c.args[0] === 'log');
    expect(config?.timeoutMs).toBe(5_000);
    expect(log?.timeoutMs).toBe(20_000);
  });
  it('still reads the other repos when one of them fails, and stays ok', async () => {
    const parent = tmp();
    const bad = fakeRepo(parent, 'bad');
    const good = fakeRepo(parent, 'good');
    const runGit: GitRunner = async (args, o) => {
      if (o.cwd === bad) throw Object.assign(new Error('x'), { code: 128, stderr: 'fatal: detected dubious ownership in repository' });
      if (args[0] === 'config') return { stdout: 'Alice\n' };
      return { stdout: `${'a'.repeat(40)}\x1f2026-11-09T10:00:00+06:00\x1fgood work` };
    };
    const r = await readGitCommits([parent], range, { runGit });
    expect(r.items.map((i) => i.text)).toEqual(['good work']);
    expect(r.status.ok).toBe(true);
    expect(r.status.note).toContain('safe.directory');
  });
  it('treats a repo with no commits yet as fine, without a note', async () => {
    const dir = fakeRepo();
    const runGit: GitRunner = async (args) => {
      if (args[0] === 'config') return { stdout: 'Alice\n' };
      throw Object.assign(new Error('x'), { code: 128, stderr: "fatal: your current branch 'main' does not have any commits yet" });
    };
    const r = await readGitCommits([dir], range, { runGit });
    expect(r.items).toEqual([]);
    expect(r.status).toMatchObject({ ok: true, count: 0 });
    expect(r.status.note).toBeUndefined();
  });
  it('only says user.name is not set when git said so (exit 1, no output)', async () => {
    const dir = fakeRepo();
    const runGit: GitRunner = async (args) => {
      if (args[0] === 'config') throw Object.assign(new Error('x'), { code: 1, stderr: '' });
      return { stdout: '' };
    };
    const r = await readGitCommits([dir], range, { runGit });
    expect(r.status.note).toContain('user.name is not set');
    expect(r.status.ok).toBe(true);
  });
});

describe('scanActivity', () => {
  const sources = { claude: true, git: true };
  it('rejects a relative path with a plain message', async () => {
    await expect(scanActivity({ date: '2026-11-09', folders: [{ path: 'relative/path', projectId: 'p' }], sources })).rejects.toThrow(/full folder path/i);
  });
  it('skips a folder that no longer exists, still reads the others, and says so', async () => {
    const missing = path.join(tmp(), 'nope');
    const real = repo();
    commit(real, 'kept work', '2026-11-09T10:00:00+06:00');
    const r = await scanActivity(
      { date: '2026-11-09', folders: [{ path: missing, projectId: 'p' }, { path: real, projectId: 'p' }], sources },
      { claudeDir: tmp(), env: isolatedEnv() },
    );
    expect(r.items.map((i) => i.text)).toEqual(['kept work']);
    expect(r.status.git.note).toContain('Folder not found, skipped');
    expect(r.status.git.note).toContain(missing);
  });
  it('returns no items, with the reason, when every listed folder is gone', async () => {
    const missing = path.join(tmp(), 'nope');
    const r = await scanActivity({ date: '2026-11-09', folders: [{ path: missing, projectId: 'p' }], sources }, { claudeDir: tmp(), env: isolatedEnv() });
    expect(r.items).toEqual([]);
    expect(r.status.git.ok).toBe(true);
    expect(r.status.git.note).toContain('Folder not found, skipped');
  });
  it('puts the skipped-folder note on Claude when git is switched off', async () => {
    const missing = path.join(tmp(), 'nope');
    const r = await scanActivity({ date: '2026-11-09', folders: [{ path: missing, projectId: 'p' }], sources: { claude: true, git: false } }, { claudeDir: tmp(), env: isolatedEnv() });
    expect(r.status.claude.note).toContain('Folder not found, skipped');
    expect(r.status.git.note).toBe('Turned off in Settings');
  });
  it('skips a folder that never answers after a few seconds, reads the others, and says so', async () => {
    const hung = path.join(tmp(), 'dead-share');
    const live = tmp();
    const realStat = fs.promises.stat;
    vi.spyOn(fs.promises, 'stat').mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p) === hung ? new Promise(() => {}) : (realStat as (...a: unknown[]) => unknown)(p, ...rest)) as never);
    const r = await scanActivity(
      { date: '2026-11-09', folders: [{ path: hung, projectId: 'a' }, { path: live, projectId: 'b' }], sources },
      { claudeDir: tmp(), env: isolatedEnv(), folderTimeoutMs: 50 },
    );
    expect(r.status.git.note).toContain(`Folder did not answer, skipped: ${hung}`);
    expect(r.status.git.note).not.toContain(live);
    expect(r.status.git.ok).toBe(true);
  });
  it('does not throw on an empty day', async () => {
    const r = await scanActivity({ date: '2026-11-09', folders: [{ path: tmp(), projectId: 'p' }], sources }, { claudeDir: tmp(), env: isolatedEnv() });
    expect(r.items).toEqual([]);
    expect(r.status.git.ok).toBe(true);
  });
  it('does not touch Claude history when that source is off', async () => {
    const claudeDir = tmp();
    const spy = vi.spyOn(fs, 'readdirSync');
    const r = await scanActivity({ date: '2026-11-09', folders: [{ path: tmp(), projectId: 'p' }], sources: { claude: false, git: false } }, { claudeDir, env: isolatedEnv() });
    expect(spy.mock.calls.some((c) => String(c[0]).startsWith(claudeDir))).toBe(false);
    expect(r.status.claude).toEqual({ ok: true, count: 0, note: 'Turned off in Settings' });
    expect(r.status.git.note).toBe('Turned off in Settings');
  });
});
