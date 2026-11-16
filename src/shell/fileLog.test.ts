import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFileLog, formatLogLine, type LogFs } from './fileLog';

const NOW = new Date('2026-11-16T04:56:40.425Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-log-'));

describe('formatLogLine', () => {
  it('is one line: time, level, area, message and the redacted detail', () => {
    const line = formatLogLine(NOW, 'ERROR', 'sheet sync', 'The Sheet did not answer.', new Error('fetch failed for owner@example.org'));
    expect(line).toBe('2026-11-16T04:56:40.425Z ERROR sheet_sync The Sheet did not answer. | fetch failed for o***@example.org\n');
  });
  it('has no detail part when there is none', () => {
    expect(formatLogLine(NOW, 'INFO', 'app', 'Started.')).toBe('2026-11-16T04:56:40.425Z INFO app Started.\n');
  });
  it('redacts secrets and the script address even in the message, and never lets a newline split a line', () => {
    const line = formatLogLine(NOW, 'WARN', 'x', 'url https://script.google.com/macros/s/AKfycbxSECRETSECRETSECRET1234/exec\nsecond ghp_' + 'a'.repeat(30));
    expect(line.trim().split('\n')).toHaveLength(1);
    expect(line).not.toMatch(/SECRETSECRET|ghp_/);
  });
  it('shortens a long message and a long detail', () => {
    const line = formatLogLine(NOW, 'INFO', 'a', 'm'.repeat(1000), 'd'.repeat(1000));
    expect(line.length).toBeLessThan(700);
  });
});

describe('createFileLog', () => {
  it('appends lines to <name>.log, creating the folder', () => {
    const dir = path.join(tmp(), 'logs');
    const log = createFileLog({ dir, name: 'main', now: () => NOW });
    log.info('app', 'one');
    log.error('app', 'two', new Error('boom'));
    const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    expect(text.split('\n').filter(Boolean)).toEqual(['2026-11-16T04:56:40.425Z INFO app one', '2026-11-16T04:56:40.425Z ERROR app two | boom']);
  });

  it('rotates at the size limit, keeping the newest files and dropping the oldest', () => {
    const dir = tmp();
    const log = createFileLog({ dir, name: 'server', maxBytes: 200, keep: 3, now: () => NOW });
    for (let i = 0; i < 30; i++) log.info('area', `message number ${i} with some padding text`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['server.1.log', 'server.2.log', 'server.log']); // never a server.3.log
    for (const f of files) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(200 + 120);
    // the newest message is in server.log, and the oldest ones are gone
    expect(fs.readFileSync(path.join(dir, 'server.log'), 'utf8')).toContain('message number 29');
    const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    expect(all).not.toContain('message number 0 ');
  });

  it('never throws when the folder cannot be written, and complains once on the console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: LogFs = {
      mkdirSync: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      appendFileSync: () => {},
      statSync: () => ({ size: 0 }),
      renameSync: () => {},
      unlinkSync: () => {},
      existsSync: () => false,
    };
    const log = createFileLog({ dir: 'X:\\nowhere', name: 'main', fs: broken });
    expect(() => {
      log.info('a', 'one');
      log.error('a', 'two');
    }).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('exposes its folder', () => {
    expect(createFileLog({ dir: 'D:\\logs', name: 'main' }).dir).toBe('D:\\logs');
  });
});
