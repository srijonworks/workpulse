import { spawn } from 'child_process';
import os from 'os';

// Runs the Claude Code command-line tool in headless mode, so the app can use the user's own
// Claude login instead of a separate API key. The prompt goes in on stdin (never as an argument),
// all tools, skills, MCP servers and user settings are switched off, and the answer is validated
// against a JSON schema. It runs from a neutral folder so no project instructions are picked up.

export const CLAUDE_MODEL = 'haiku';
export const CLAUDE_TIMEOUT_MS = 60_000;
const MAX_STDOUT_CHARS = 5_000_000;
const MAX_STDERR_CHARS = 100_000;

export type ClaudeRunResult = { ok: true; data: unknown } | { ok: false; reason: string };

export function claudeArgs(schema: object, model: string): string[] {
  return [
    '-p',
    '--tools', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--output-format', 'json',
    '--model', model,
    '--effort', 'low',
    '--json-schema', JSON.stringify(schema),
  ];
}

const SIGN_IN = /not logged in|please run \/login|\/login|authenticat|invalid api key|credential/i;
const SIGN_IN_REASON = 'Claude Code is not signed in. Open a terminal, run "claude" once and log in.';

const firstLine = (text: string): string => text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 200) ?? '';

// The answer as JSON, from text that may be wrapped in a code fence or have a sentence around it.
function jsonFromText(text: string): unknown {
  const body = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(body);
  } catch {
    const from = body.indexOf('{');
    const to = body.lastIndexOf('}');
    if (from < 0 || to <= from) return undefined;
    try {
      return JSON.parse(body.slice(from, to + 1));
    } catch {
      return undefined;
    }
  }
}

export function runClaudeJson(opts: {
  prompt: string;
  schema: object;
  model?: string;
  timeoutMs?: number;
  cwd?: string;
  spawnFn?: typeof spawn;
}): Promise<ClaudeRunResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn('claude', claudeArgs(opts.schema, opts.model ?? CLAUDE_MODEL), {
        cwd: opts.cwd ?? os.tmpdir(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ ok: false, reason: `Could not start Claude Code (${err instanceof Error ? err.message : 'unknown error'}).` });
    }

    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, reason: 'Claude Code took too long to answer.' });
    }, opts.timeoutMs ?? CLAUDE_TIMEOUT_MS);

    // The answer is one small JSON object and the error text is read for its first line: neither needs more.
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      if (stdout.length < MAX_STDOUT_CHARS) stdout += d;
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += d;
    });
    // Claude Code can exit before it reads the prompt (not signed in, bad arguments). Writing to it then fails with
    // EPIPE on stdin; without a listener that error is uncaught and would take the whole desktop app down. The
    // "close" event below reports what happened.
    let stdinFailed = false;
    child.stdin?.on('error', () => {
      stdinFailed = true;
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      done({
        ok: false,
        reason: err.code === 'ENOENT'
          ? 'Claude Code is not installed or is not on this computer\'s PATH.'
          : `Could not start Claude Code (${err.message}).`,
      });
    });

    child.on('close', (code) => {
      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = undefined;
      }

      if (parsed?.is_error === true) {
        const text = typeof parsed.result === 'string' ? parsed.result : '';
        return done({ ok: false, reason: SIGN_IN.test(text) ? SIGN_IN_REASON : `Claude Code reported a problem: ${firstLine(text) || 'unknown error'}` });
      }
      if (code !== 0 && parsed === undefined) {
        const said = stderr || stdout;
        if (SIGN_IN.test(said)) return done({ ok: false, reason: SIGN_IN_REASON });
        if (stdinFailed && !firstLine(said)) return done({ ok: false, reason: 'Claude Code stopped before it could read the request.' });
        return done({ ok: false, reason: `Claude Code failed: ${firstLine(said) || `exit code ${code}`}` });
      }
      if (parsed && typeof parsed === 'object' && parsed.structured_output && typeof parsed.structured_output === 'object') {
        return done({ ok: true, data: parsed.structured_output });
      }
      const fromText = typeof parsed?.result === 'string' ? jsonFromText(parsed.result) : undefined;
      if (fromText && typeof fromText === 'object') return done({ ok: true, data: fromText });
      done({ ok: false, reason: 'Claude Code gave an unreadable answer.' });
    });

    child.stdin?.end(opts.prompt);
  });
}
