import type { Project } from '../types';
import { SWATCHES } from '../components/v2/ProjectSwatches';
import { defaultProject, projectsForTag } from './projects';

export interface CompletionState {
  /** True when the list should show: matching projects, or the "Create it" row. */
  open: boolean;
  /** The letters typed after the "#" (empty for a bare "#"). */
  query: string;
  /** Active projects whose names start with the query (all of them for a bare "#"); with none, those one typo away. */
  matches: Project[];
  /** No project name starts with a non-empty, non-numeric word: offer to create it (after any typo matches). */
  canCreate: boolean;
  /** Where the "#word" sits in the text: wordStart is the "#", wordEnd the end of the word. */
  wordStart: number;
  wordEnd: number;
}

/** The "#word" at the end of `text`: where its "#" sits (-1 when the last word is not a tag) and the letters after it. */
function lastTag(text: string): { wordStart: number; query: string } {
  const m = /(?:^|\s)#(\S*)$/.exec(text);
  return m ? { wordStart: m.index + m[0].length - m[1].length - 1, query: m[1] } : { wordStart: -1, query: '' };
}

const CLOSED: CompletionState = { open: false, query: '', matches: [], canCreate: false, wordStart: -1, wordEnd: -1 };

/**
 * Completion for the last word of `text` (for a textarea, pass the text up to the caret). It opens when that
 * word starts with "#" and is not purely digits, so "Review PR #212" is left alone. Matching ignores case and
 * spaces and skips archived projects, like `splitProjectTag`.
 */
export function completionState(text: string, projects: Project[]): CompletionState {
  const { query, wordStart } = lastTag(text);
  if (wordStart < 0 || /^\d+$/.test(query)) return CLOSED;
  const found = projectsForTag(query, projects);
  // Nothing starts with the word: offer the projects one typo away ("#hmis" for "hims") above the "Create it" row.
  const matches = found.prefix.length > 0 ? found.prefix : found.close;
  const canCreate = found.prefix.length === 0 && query.length > 0;
  return { open: matches.length > 0 || canCreate, query, matches, canCreate, wordStart, wordEnd: text.length };
}

/** The tag form of a name: spaces dropped so "#HMISPortal" stays one word that `splitProjectTag` can match. */
export const tagOf = (project: Project): string => `#${project.name.replace(/\s+/g, '')}`;

/**
 * Picks `project` for the last word of `text`. 'remove' drops the "#word" (the selector shows the project);
 * 'replace' writes the full tag in its place so each line of a textarea keeps its own project.
 */
export function applyCompletion(text: string, project: Project, mode: 'remove' | 'replace'): string {
  const { wordStart } = lastTag(text);
  if (wordStart < 0) return text;
  const before = text.slice(0, wordStart);
  return mode === 'remove' ? before.replace(/\s+$/, '') : `${before}${tagOf(project)}`;
}

/** The next unused project colour from the fixed swatches (cycling once all eight are taken). */
export function nextSwatchColor(projects: Project[]): string {
  const used = new Set(projects.map((p) => (p.color ?? '').toLowerCase()));
  return (SWATCHES.find((s) => !used.has(s.hex.toLowerCase())) ?? SWATCHES[projects.length % SWATCHES.length]).hex;
}

/** The project the selector shows: the one picked this session, else the last one used, else the first active. */
export function resolveProject(projects: Project[], chosenId: string | undefined, lastId: string | undefined): Project | undefined {
  const usable = (id: string | undefined) => (id ? projects.find((p) => p.id === id && !p.isArchived && !p.trashedAt) : undefined);
  return usable(chosenId) ?? usable(lastId) ?? defaultProject(projects);
}
