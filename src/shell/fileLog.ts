import fs from 'node:fs';
import path from 'node:path';
import { clip } from '../utils/activity/sanitize';
import { redactForLog, safeDetail } from '../utils/health/redact';

// A small rotating log in a folder of the user's own (~/WorkPulse/logs). It records what happened and where, never what
// the user wrote: the caller gives an area, a fixed sentence and an error's detail, and every line goes through the
// redaction. It never throws: a log that cannot be written must not become another problem.

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** The part of `fs` the log uses, so tests can fail it. */
export interface LogFs {
  mkdirSync(dir: string, opts: { recursive: true }): void;
  appendFileSync(file: string, data: string): void;
  statSync(file: string): { size: number };
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
  existsSync(file: string): boolean;
}

export interface FileLog {
  info(area: string, message: string, detail?: unknown): void;
  warn(area: string, message: string, detail?: unknown): void;
  error(area: string, message: string, detail?: unknown): void;
  /** The folder the files are in (for "Open the log folder"). */
  readonly dir: string;
}

export const LOG_MAX_BYTES = 1_000_000;
export const LOG_KEEP = 3;
const MAX_MESSAGE = 300;

export function formatLogLine(now: Date, level: LogLevel, area: string, message: string, detail?: unknown): string {
  const tail = safeDetail(detail);
  const head = `${now.toISOString()} ${level} ${clip(area.replace(/\s+/g, '_'), 40)} ${clip(redactForLog(message).replace(/\s+/g, ' ').trim(), MAX_MESSAGE)}`;
  return tail ? `${head} | ${tail}\n` : `${head}\n`;
}

export function createFileLog(opts: {
  dir: string;
  /** "main" gives main.log, main.1.log, main.2.log. */
  name: string;
  maxBytes?: number;
  keep?: number;
  now?: () => Date;
  fs?: LogFs;
}): FileLog {
  const io: LogFs = opts.fs ?? fs;
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const keep = Math.max(1, opts.keep ?? LOG_KEEP);
  const now = opts.now ?? (() => new Date());
  const file = (n: number) => path.join(opts.dir, n === 0 ? `${opts.name}.log` : `${opts.name}.${n}.log`);
  let warned = false;

  const rotate = () => {
    // main.2.log is dropped, main.1.log becomes main.2.log, main.log becomes main.1.log.
    for (let n = keep - 1; n >= 0; n--) {
      const from = file(n);
      if (!io.existsSync(from)) continue;
      if (n === keep - 1) io.unlinkSync(from);
      else io.renameSync(from, file(n + 1));
    }
  };

  const write = (level: LogLevel, area: string, message: string, detail?: unknown) => {
    try {
      const line = formatLogLine(now(), level, area, message, detail);
      io.mkdirSync(opts.dir, { recursive: true });
      let size = 0;
      try {
        size = io.statSync(file(0)).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + line.length > maxBytes) rotate();
      io.appendFileSync(file(0), line);
    } catch (err) {
      if (!warned) {
        warned = true;
        console.error('WorkPulse could not write its log file:', err instanceof Error ? err.message : err);
      }
    }
  };

  return {
    info: (area, message, detail) => write('INFO', area, message, detail),
    warn: (area, message, detail) => write('WARN', area, message, detail),
    error: (area, message, detail) => write('ERROR', area, message, detail),
    dir: opts.dir,
  };
}
