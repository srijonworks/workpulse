import type { ActivityAi } from './activity/types';

export interface WriterResult {
  writer: 'claude' | 'gemini' | 'template';
  /** ISO time of the outcome. */
  at: string;
  /** Plain sentence: why the chosen writer was not used. */
  notice?: string;
}

export interface AiWriterStatus {
  state: 'ok' | 'fallback' | 'none';
  sentence: string;
}

/**
 * Plain status of the AI writer for the System status screen. `lastResults` = recent outcomes, any order.
 * No raw error text: the notice is only used to tell "key missing" apart.
 */
export function describeAiWriter(input: {
  ai: ActivityAi | undefined;
  geminiKey?: string;
  lastResults?: WriterResult[];
}): AiWriterStatus {
  const ai = input.ai ?? 'claude';
  if (ai === 'none') {
    return { state: 'none', sentence: 'The AI writer is switched off, so WorkPulse uses plain wording.' };
  }
  const name = ai === 'claude' ? 'Claude Code' : 'Gemini';
  if (ai === 'gemini' && !(input.geminiKey ?? '').trim()) {
    return {
      state: 'fallback',
      sentence: 'Gemini is chosen but no key is saved, so WorkPulse is using plain wording. Add a key in Settings, or pick another writer.',
    };
  }
  const latest = [...(input.lastResults ?? [])].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!latest) {
    return { state: 'ok', sentence: `${name} writes the text. Nothing has been written yet.` };
  }
  if (latest.writer === 'template') {
    const other = ai === 'claude' ? 'Gemini' : 'Claude Code';
    const otherReady = ai === 'claude' && (input.geminiKey ?? '').trim();
    return {
      state: 'fallback',
      sentence: otherReady
        ? `${name} is not available, so WorkPulse is using plain wording. It tries again by itself. ${other} has a key if you want to switch.`
        : 'The AI writer is not available, so WorkPulse is using plain wording. It tries again by itself.',
    };
  }
  if (latest.writer !== ai) {
    return {
      state: 'fallback',
      sentence: `${name} was not available, so ${latest.writer === 'claude' ? 'Claude Code' : 'Gemini'} wrote the last text. It tries ${name} again by itself.`,
    };
  }
  return { state: 'ok', sentence: `${name} is writing the text.` };
}
