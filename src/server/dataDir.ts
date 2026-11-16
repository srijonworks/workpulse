import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WorkPulse's own folder on this computer: its log files now, and the copies of the user's data. By default it is
// "WorkPulse" in the user's home folder. For a test run, `--data-dir=temp` (a fresh temporary folder) or
// `--data-dir=<path>`, or the WORKPULSE_DATA_DIR environment variable, keeps everything out of the real folder.

export function dataDir(opts: { argv?: readonly string[]; env?: NodeJS.ProcessEnv; home?: string; makeTemp?: () => string } = {}): string {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const flag = argv.find((a) => a.startsWith('--data-dir='))?.slice('--data-dir='.length).trim();
  if (flag === 'temp') return (opts.makeTemp ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), 'workpulse-data-'))))();
  if (flag) return path.resolve(flag);
  const fromEnv = env.WORKPULSE_DATA_DIR?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(home, 'WorkPulse');
}

export const logsDir = (dir: string): string => path.join(dir, 'logs');
export const backupsDir = (dir: string): string => path.join(dir, 'backups');
