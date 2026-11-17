import type { StandupRecord } from '../types';

/** True when a standup was written from the plain template and the user has not edited it: worth asking the AI again. */
export function needsRewrite(standup: StandupRecord): boolean {
  return standup.writer === 'template' && !standup.editedAt;
}

/** Replace the text of standup `id` with an AI rewrite. Keeps createdAt, sets writer, clears notice. Edited standups are never touched. */
export function applyRewrite(
  standups: StandupRecord[],
  id: string,
  newText: string,
  writer: 'claude' | 'gemini',
): StandupRecord[] {
  return standups.map((s) => {
    if (s.id !== id || s.editedAt) return s;
    const { notice: _notice, ...rest } = s;
    return { ...rest, text: newText, writer };
  });
}
