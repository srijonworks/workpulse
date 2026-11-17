import type { WriterResult } from './aiStatus';

// A short memory of which writer (Claude, Gemini or the plain template) wrote the last logs and standups, so the System status
// screen can say plainly when the AI is not available. Device-only. Never throws.

export const AI_RESULTS_KEY = 'workpulse_ai_results';
const KEEP = 12;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadAiResults(storage: StorageLike): WriterResult[] {
  try {
    const v = JSON.parse(storage.getItem(AI_RESULTS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is WriterResult => !!r && typeof r === 'object' && ['claude', 'gemini', 'template'].includes((r as WriterResult).writer) && typeof (r as WriterResult).at === 'string',
    );
  } catch {
    return [];
  }
}

export function recordAiResult(storage: StorageLike, writer: WriterResult['writer'], notice?: string, now: Date = new Date()): void {
  try {
    const next = [...loadAiResults(storage), { writer, at: now.toISOString(), ...(notice ? { notice } : {}) }].slice(-KEEP);
    storage.setItem(AI_RESULTS_KEY, JSON.stringify(next));
  } catch {
    // a note about the writer must never stop the app
  }
}
