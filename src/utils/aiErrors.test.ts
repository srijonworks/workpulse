import { describe, expect, it } from 'vitest';
import { isTransientSheetText, plainAiMessage, plainSheetMessage } from './aiErrors';

describe('plainAiMessage', () => {
  it('says offline first', () => {
    expect(plainAiMessage('Failed to fetch', false)).toMatch(/offline/i);
  });
  it('explains a missing or rejected key and a usage limit', () => {
    expect(plainAiMessage('No Gemini API key provided. Please configure your key in Settings or set GEMINI_API_KEY.', true)).toMatch(/No Gemini key is set/);
    expect(plainAiMessage('[400] API_KEY_INVALID', true)).toMatch(/did not accept the key/);
    expect(plainAiMessage('429 RESOURCE_EXHAUSTED: quota', true)).toMatch(/usage limit/);
  });
  it('explains a server that cannot be reached', () => {
    expect(plainAiMessage('Failed to fetch', true)).toMatch(/could not reach its server/);
    expect(plainAiMessage('Could not reach the WorkPulse server.', true)).toMatch(/still running/);
  });
  it('passes other short messages through and shortens long ones', () => {
    expect(plainAiMessage('Model said no.', true)).toBe('Model said no.');
    expect(plainAiMessage('x'.repeat(300), true).length).toBeLessThanOrEqual(160);
    expect(plainAiMessage(undefined, true)).toBe('The AI did not answer.');
  });
});

describe('plainSheetMessage', () => {
  it('names the likely cause', () => {
    expect(plainSheetMessage('x', false)).toMatch(/offline/i);
    expect(plainSheetMessage('Failed to fetch', true)).toMatch(/could not reach/);
    expect(plainSheetMessage('HTTP 403', true)).toMatch(/refused/);
    expect(plainSheetMessage('', true)).toMatch(/did not accept/);
  });
  it('turns the raw errors of an older script into plain sentences', () => {
    expect(plainSheetMessage('Exception: Lock timeout: another process was holding the lock for too long.', true)).toMatch(/busy with another request/);
    expect(plainSheetMessage('Exception: Service invoked too many times for one day: urlfetch.', true)).toMatch(/Google had a problem/);
    expect(plainSheetMessage('Exception: Service Spreadsheets failed while accessing document with id abc.', true)).toMatch(/Google had a problem/);
    expect(plainSheetMessage('Exceeded maximum execution time', true)).toMatch(/Google had a problem/);
    expect(plainSheetMessage('Authorization is required to perform that action.', true)).toMatch(/refused/);
  });
  it('never shows the Google document id or the exception name for those cases', () => {
    const out = plainSheetMessage('Exception: Service Spreadsheets failed while accessing document with id 1AbCdEf', true);
    expect(out).not.toMatch(/Exception|1AbCdEf/);
  });
});

describe('isTransientSheetText', () => {
  it('is true only for "not now" answers', () => {
    expect(isTransientSheetText('Exception: Lock timeout: another process was holding the lock')).toBe(true);
    expect(isTransientSheetText('Service invoked too many times')).toBe(true);
    expect(isTransientSheetText('Exceeded maximum execution time')).toBe(true);
    expect(isTransientSheetText('That PIN is not right.')).toBe(false);
    expect(isTransientSheetText('')).toBe(false);
    expect(isTransientSheetText(undefined)).toBe(false);
  });
});
