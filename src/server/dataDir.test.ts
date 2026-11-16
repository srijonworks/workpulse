import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupsDir, dataDir, logsDir } from './dataDir';

const home = path.resolve('/home/someone');

describe('dataDir', () => {
  it('is WorkPulse in the home folder by default', () => {
    expect(dataDir({ argv: [], env: {}, home })).toBe(path.join(home, 'WorkPulse'));
  });
  it('follows the WORKPULSE_DATA_DIR variable', () => {
    expect(dataDir({ argv: [], env: { WORKPULSE_DATA_DIR: path.resolve('/data/wp') }, home })).toBe(path.resolve('/data/wp'));
    expect(dataDir({ argv: [], env: { WORKPULSE_DATA_DIR: '   ' }, home })).toBe(path.join(home, 'WorkPulse'));
  });
  it('lets the --data-dir flag win over the variable', () => {
    expect(dataDir({ argv: ['node', 'server.ts', `--data-dir=${path.resolve('/flag/dir')}`], env: { WORKPULSE_DATA_DIR: path.resolve('/env/dir') }, home })).toBe(path.resolve('/flag/dir'));
  });
  it('makes a fresh temporary folder for --data-dir=temp', () => {
    let made = 0;
    const r = dataDir({ argv: ['--data-dir=temp'], env: {}, home, makeTemp: () => `temp-${++made}` });
    expect(r).toBe('temp-1');
    expect(made).toBe(1);
  });
  it('names the logs and backups folders under it', () => {
    expect(logsDir('D:\\wp')).toBe(path.join('D:\\wp', 'logs'));
    expect(backupsDir('D:\\wp')).toBe(path.join('D:\\wp', 'backups'));
  });
});
