import { describe, expect, it } from 'vitest';
import { redactForLog, safeDetail } from './redact';

describe('redactForLog', () => {
  it('keeps only the ends of the script address id', () => {
    const out = redactForLog('POST https://script.google.com/macros/s/AKfycbxSECRETSECRETSECRET1234/exec failed');
    expect(out).toContain('https://script.google.com/macros/s/AKfy…1234/exec');
    expect(out).not.toContain('SECRETSECRET');
  });
  it('blanks a PIN, token or key inside a JSON request body', () => {
    const body = '{"action":"setPin","pin":"4821","oldPin":"1111","token":"abc123tok","customApiKey":"key","note":"keep"}';
    const out = redactForLog(body);
    expect(out).not.toMatch(/4821|1111|abc123tok|"key"/);
    expect(out).toContain('"pin":"***"');
    expect(out).toContain('"note":"keep"');
  });
  it('masks e-mail addresses but keeps the domain', () => {
    expect(redactForLog('sent to owner@example.org and a.b@mail.example.com')).toBe('sent to o***@example.org and a***@mail.example.com');
  });
  it('hides the Windows user name in a path', () => {
    expect(redactForLog('Could not write C:\\Users\\DELL\\WorkPulse\\backups\\x.json')).toBe('Could not write C:\\Users\\<user>\\WorkPulse\\backups\\x.json');
  });
  it('still removes the keys and tokens the activity code removes', () => {
    const out = redactForLog('key AIza' + 'a'.repeat(35) + ' and ghp_' + 'b'.repeat(30));
    expect(out).not.toMatch(/AIza|ghp_/);
  });
  it('leaves ordinary text alone', () => {
    expect(redactForLog('The Sheet is busy with another request.')).toBe('The Sheet is busy with another request.');
  });
});

describe('safeDetail', () => {
  it('takes an Error, redacts it, puts it on one line and shortens it', () => {
    const out = safeDetail(new Error('failed for owner@example.org\nat C:\\Users\\DELL\\app.js ' + 'x'.repeat(500)));
    expect(out).not.toContain('\n');
    expect(out).not.toMatch(/owner@|DELL/);
    expect(out.length).toBeLessThanOrEqual(300);
  });
  it('copes with anything', () => {
    expect(safeDetail(undefined)).toBe('');
    expect(safeDetail(null)).toBe('');
    expect(safeDetail(42)).toBe('42');
  });
});
