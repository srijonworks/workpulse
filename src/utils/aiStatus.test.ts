import { describe, expect, it } from 'vitest';
import { describeAiWriter } from './aiStatus';

const r = (writer: 'claude' | 'gemini' | 'template', at: string, notice?: string) => ({ writer, at, notice });

describe('describeAiWriter', () => {
  it('none', () => {
    expect(describeAiWriter({ ai: 'none' }).state).toBe('none');
  });
  it('claude, nothing yet, defaults when ai undefined', () => {
    const s = describeAiWriter({ ai: undefined, lastResults: [] });
    expect(s.state).toBe('ok');
    expect(s.sentence).toContain('Claude Code');
  });
  it('claude unavailable and no gemini key', () => {
    const s = describeAiWriter({ ai: 'claude', lastResults: [r('template', '2026-11-17T10:00:00Z', 'spawn ENOENT claude')] });
    expect(s).toEqual({
      state: 'fallback',
      sentence: 'The AI writer is not available, so WorkPulse is using plain wording. It tries again by itself.',
    });
    expect(s.sentence).not.toContain('ENOENT');
  });
  it('claude unavailable but gemini key present', () => {
    const s = describeAiWriter({ ai: 'claude', geminiKey: 'k', lastResults: [r('template', '2026-11-17T10:00:00Z')] });
    expect(s.state).toBe('fallback');
    expect(s.sentence).toContain('Gemini has a key');
  });
  it('uses the newest result regardless of order', () => {
    const s = describeAiWriter({
      ai: 'claude',
      lastResults: [r('claude', '2026-11-17T11:00:00Z'), r('template', '2026-11-17T09:00:00Z')],
    });
    expect(s.state).toBe('ok');
  });
  it('gemini without key', () => {
    const s = describeAiWriter({ ai: 'gemini', geminiKey: ' ', lastResults: [r('gemini', '2026-11-17T11:00:00Z')] });
    expect(s.state).toBe('fallback');
    expect(s.sentence).toContain('no key');
  });
  it('gemini chosen but another writer answered', () => {
    const s = describeAiWriter({ ai: 'gemini', geminiKey: 'k', lastResults: [r('claude', '2026-11-17T11:00:00Z')] });
    expect(s.state).toBe('fallback');
  });
  it('gemini ok', () => {
    expect(describeAiWriter({ ai: 'gemini', geminiKey: 'k', lastResults: [r('gemini', '2026-11-17T11:00:00Z')] }).state).toBe('ok');
  });
});
