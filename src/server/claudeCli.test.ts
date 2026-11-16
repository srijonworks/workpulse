import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { claudeArgs, runClaudeJson } from './claudeCli';

const SCHEMA = { type: 'object', properties: { tasks: { type: 'array' } }, required: ['tasks'] };

// A stand-in for child_process.spawn: records what was started and lets the test play the process.
function fakeSpawn() {
  const calls: { cmd: string; args: string[]; options: any }[] = [];
  let child: any;
  const spawnFn: any = (cmd: string, args: string[], options: any) => {
    calls.push({ cmd, args, options });
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdinData = '';
    // The real stdin is an event emitter: with no 'error' listener, emitting 'error' on it throws (an uncaught error).
    child.stdin = Object.assign(new EventEmitter(), { end: (d: string) => { child.stdinData = d; } });
    child.kill = vi.fn();
    return child;
  };
  return {
    spawnFn,
    calls,
    child: () => child,
    finish: (stdout: string, code = 0, stderr = '') => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('claudeArgs', () => {
  it('runs headless with no tools, no extras and a validated JSON answer', () => {
    const args = claudeArgs(SCHEMA, 'haiku');
    expect(args).toContain('-p');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    for (const flag of ['--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence']) expect(args).toContain(flag);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1])).toEqual(SCHEMA);
  });
});

describe('runClaudeJson', () => {
  it('sends the prompt on stdin (never as an argument), without a shell, from a neutral folder', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'SECRET-ISH PROMPT TEXT', schema: SCHEMA, spawnFn: f.spawnFn, cwd: '/tmp/x' });
    f.finish(JSON.stringify({ is_error: false, structured_output: { tasks: [] } }));
    await run;
    expect(f.child().stdinData).toBe('SECRET-ISH PROMPT TEXT');
    expect(f.calls[0].args.join(' ')).not.toContain('SECRET-ISH');
    expect(f.calls[0].cmd).toBe('claude');
    expect(f.calls[0].options.shell).not.toBe(true);
    expect(f.calls[0].options.cwd).toBe('/tmp/x');
  });
  it('returns the structured output', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
    f.finish(JSON.stringify({ is_error: false, structured_output: { tasks: [{ text: 'A', itemIds: ['i1'] }] } }));
    await expect(run).resolves.toEqual({ ok: true, data: { tasks: [{ text: 'A', itemIds: ['i1'] }] } });
  });
  it('falls back to JSON in the text result, even inside a code fence', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
    f.finish(JSON.stringify({ is_error: false, result: '```json\n{"tasks":[]}\n```' }));
    await expect(run).resolves.toEqual({ ok: true, data: { tasks: [] } });
  });
  it('says Claude Code is not installed when it cannot be started', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
    f.child().emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    const r = await run;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Claude Code is not installed/i);
  });
  it('says to sign in when Claude Code is not logged in', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
    f.finish('', 1, 'Not logged in · Please run /login');
    const r = await run;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not signed in/i);
  });
  it('reports a failed run with the first line of what Claude Code said', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
    f.finish('', 2, 'Something broke\nsecond line');
    const r = await run;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('Something broke');
      expect(r.reason).not.toContain('second line');
    }
  });
  it('reports an error answer', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
    f.finish(JSON.stringify({ is_error: true, result: 'Rate limit reached' }));
    const r = await run;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Rate limit reached');
  });
  it('reports output that is not JSON or has no usable answer as unreadable', async () => {
    for (const out of ['not json at all', JSON.stringify({ is_error: false, result: 'Sure, here you go' })]) {
      const f = fakeSpawn();
      const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
      f.finish(out);
      const r = await run;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/unreadable/i);
    }
  });
  it('does not crash when Claude Code exits before reading the request (EPIPE on stdin)', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
    // emit() throws when nobody listens for 'error', which is what would be an uncaught error in the real app
    expect(() => f.child().stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    f.finish('', 1, 'Not logged in · Please run /login');
    const r = await run;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not signed in/i);
  });
  it('names an early exit when Claude Code said nothing at all', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
    f.child().stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    f.finish('', 1, '');
    const r = await run;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/stopped before it could read/i);
  });
  it('still reports the first line when Claude Code prints a huge error', async () => {
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn });
    f.child().stderr.emit('data', Buffer.from('Something broke\n'));
    for (let i = 0; i < 30; i++) f.child().stderr.emit('data', Buffer.from('x'.repeat(50_000)));
    f.finish('', 2);
    const r = await run;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Something broke');
  });
  it('stops a run that takes too long', async () => {
    vi.useFakeTimers();
    const f = fakeSpawn();
    const run = runClaudeJson({ prompt: 'p', schema: SCHEMA, spawnFn: f.spawnFn, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    const r = await run;
    expect(f.child().kill).toHaveBeenCalled();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/i);
  });
});
