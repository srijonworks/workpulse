/**
 * The list of activity sources (what WorkPulse reads to suggest logs).
 *
 * To add a source: add a descriptor here, add a reader in src/server/readers, done.
 *
 * The AppSettings field named by `settingKey` must exist in src/types.ts (optional boolean, on unless false).
 * Everything else (Settings checkboxes, the data notice, the consent signature, the scan request, evidence
 * text, the scan loop on the server) loops over this list. Pure: no fs, shared by the page and the server.
 */
import type { AppSettings } from '../../types';

export interface SourceDescriptor {
  id: string;
  /** Plain label, e.g. 'Claude Code prompts'. */
  label: string;
  /** The existing AppSettings key. Absent or true = on, false = off. */
  settingKey: keyof AppSettings;
  /** prompts = what you asked an AI tool, changes = commits, files = documents. */
  kind: 'prompts' | 'changes' | 'files';
  /** Short name, e.g. 'Claude Code'. */
  short: string;
  /** The sentence the data notice shows for this source. `aiName` is 'Claude' or 'Gemini'. */
  noticeLine: (aiName: string) => string;
  /** Title and description of its Settings checkbox. */
  settingsText: { title: string; description: string };
  /** '2 Claude sessions' for n items (or n sessions, see `countSessions`). */
  evidence: (n: number) => string;
  /** Count distinct sessions (the middle part of the item id) instead of items for `evidence`. */
  countSessions: boolean;
  /** The item is a prompt the user typed (so trivial ones can be left out and the data notice mentions AI tools). */
  promptLike: boolean;
  /** Word the AI prompt uses for one item of this source. */
  aiKind: string;
  /** Order in Settings, the data notice, evidence text and the consent signature (the order they always had). */
  displayRank: number;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const SOURCES = [
  {
    id: 'claude',
    label: 'Claude Code prompts',
    settingKey: 'activityUseClaude',
    kind: 'prompts',
    short: 'Claude Code',
    noticeLine: (ai: string) => `The first line of your Claude Code prompts, session titles and edited file names go to ${ai} too.`,
    settingsText: {
      title: 'Include Claude Code prompts',
      description:
        'Reads your Claude Code session history for these folders: the first line of your prompts, session titles and edited file names. File contents are never read.',
    },
    evidence: (n: number) => plural(n, 'Claude session'),
    countSessions: true,
    promptLike: true,
    aiKind: 'claude',
    displayRank: 1,
  },
  {
    id: 'git',
    label: 'Git commits',
    settingKey: 'activityUseGit',
    kind: 'changes',
    short: 'Git',
    noticeLine: (ai: string) =>
      `The subjects of your git commits go to ${ai === 'Claude' ? 'Claude, through the Claude Code on this computer,' : ai} so it can group them and write the log text.`,
    settingsText: { title: 'Include git commits', description: 'Commits you made today in these folders.' },
    evidence: (n: number) => plural(n, 'commit'),
    countSessions: false,
    promptLike: false,
    aiKind: 'commit',
    displayRank: 0,
  },
  {
    id: 'opencode',
    label: 'OpenCode prompts',
    settingKey: 'activityUseOpenCode',
    kind: 'prompts',
    short: 'OpenCode',
    noticeLine: (ai: string) => `The first line of your OpenCode prompts goes to ${ai} too.`,
    settingsText: {
      title: 'Include OpenCode prompts',
      description: 'Reads your OpenCode history on this computer for these folders: the first line of your prompts only.',
    },
    evidence: (n: number) => plural(n, 'OpenCode session'),
    countSessions: true,
    promptLike: true,
    aiKind: 'opencode',
    displayRank: 2,
  },
  {
    id: 'codex',
    label: 'Codex prompts',
    settingKey: 'activityUseCodex',
    kind: 'prompts',
    short: 'Codex',
    noticeLine: (ai: string) => `The first line of your Codex prompts goes to ${ai} too.`,
    settingsText: {
      title: 'Include Codex prompts',
      description: 'Reads your Codex CLI history on this computer for these folders: the first line of your prompts only.',
    },
    evidence: (n: number) => plural(n, 'Codex session'),
    countSessions: true,
    promptLike: true,
    aiKind: 'codex',
    displayRank: 3,
  },
  {
    id: 'docs',
    label: 'Documents',
    settingKey: 'activityUseDocs',
    kind: 'files',
    short: 'Documents',
    noticeLine: (ai: string) => `The names of documents you changed go to ${ai} too (never their contents).`,
    settingsText: {
      title: 'Include documents',
      description:
        'Word, Excel, PowerPoint and PDF files you changed today in these folders. Only the file name and time are used; files are never opened.',
    },
    evidence: (n: number) => plural(n, 'document'),
    countSessions: false,
    promptLike: false,
    aiKind: 'document',
    displayRank: 4,
  },
  {
    id: 'files',
    label: 'Files you changed',
    settingKey: 'activityUseFiles',
    kind: 'files',
    short: 'Files',
    noticeLine: (ai: string) => `The names of files you changed in your project folders go to ${ai} too (never their contents).`,
    settingsText: {
      title: 'Include files you changed',
      description:
        'Which files you changed today in these folders, by name and time only. It shows your work on a day with no commit or AI tool. Files are never opened.',
    },
    evidence: (n: number) => plural(n, 'edit batch', 'edit batches'),
    countSessions: false,
    promptLike: false,
    aiKind: 'files',
    displayRank: 5,
  },
] as const satisfies readonly SourceDescriptor[];

/** Scan and summary order. */
export const ACTIVITY_SOURCES: readonly SourceDescriptor[] = SOURCES;

export type ActivitySource = (typeof SOURCES)[number]['id'];
export const ACTIVITY_SOURCE_IDS: readonly ActivitySource[] = SOURCES.map((s) => s.id);

/** The AppSettings keys the sources are stored under. */
export type ActivitySettingKey = (typeof SOURCES)[number]['settingKey'];

/** Every id optional: a missing one counts as on (the default), only `false` is off. */
export type ActivitySources = { [K in ActivitySource]?: boolean };

/** The descriptor for an id; undefined for an id that is not registered (old stored data, a task item). */
export function describe(id: string, registry: readonly SourceDescriptor[] = ACTIVITY_SOURCES): SourceDescriptor | undefined {
  return registry.find((s) => s.id === id);
}

/** Descriptors in Settings / notice / consent-signature order. */
export function byDisplayRank(registry: readonly SourceDescriptor[] = ACTIVITY_SOURCES): SourceDescriptor[] {
  return [...registry].sort((a, b) => a.displayRank - b.displayRank);
}

/** True when the source is switched on. Absent = off here: callers that mean "default on" use `sourcesFromSettings`. */
export const isOn = (sources: Record<string, boolean | undefined>, id: string): boolean => sources[id] === true;

/** Whether the source is a typed prompt (Claude Code, OpenCode, Codex). False for an unknown id such as 'task'. */
export function isPromptLike(source: string, registry: readonly SourceDescriptor[] = ACTIVITY_SOURCES): boolean {
  return describe(source, registry)?.promptLike === true;
}

/** Whether any switched-on source is a typed prompt. */
export function anyPromptSourceOn(sources: Record<string, boolean | undefined>, registry: readonly SourceDescriptor[] = ACTIVITY_SOURCES): boolean {
  return registry.some((s) => s.promptLike && isOn(sources, s.id));
}
