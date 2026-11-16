export type ActivitySource = 'claude' | 'git' | 'opencode' | 'codex' | 'docs';

/** Where an item came from: a scanned source, or a done task of the day (merged into the same suggestions). */
export type ItemSource = ActivitySource | 'task';

/** Who writes the text (standup, end of day, log suggestions): Claude Code on this computer, Gemini, or no AI (templates / plain wording). */
export type ActivityAi = 'claude' | 'gemini' | 'none';

export interface ActivityFolder {
  path: string;
  projectId: string;
}

export interface ActivitySources {
  claude: boolean;
  git: boolean;
  /** OpenCode and Codex CLI history. Read only when true (the page turns them on after the user agreed to the notice). */
  opencode?: boolean;
  codex?: boolean;
  /** Document files (names and times only). Read only when true. */
  docs?: boolean;
}

export interface ActivityItem {
  /** git:<hash> | claude:<sessionId>:<messageUuid>[:<n>] | opencode:<sessionId>:<messageId> | codex:<sessionId>:<ordinal> | wip:<date>:<hash> (uncommitted changes, source git) | doc:<date>:<hash> | task:<taskId> */
  id: string;
  source: ItemSource;
  /** The listed ActivityFolder.path this item belongs to (deepest match). */
  folder: string;
  /** ISO UTC. */
  time: string;
  /** Already redacted and clipped. */
  text: string;
}

export interface SourceStatus {
  ok: boolean;
  count: number;
  note?: string;
}

export interface ScanRequest {
  date: string;
  folders: ActivityFolder[];
  sources: ActivitySources;
}

export interface ScanResponse {
  items: ActivityItem[];
  status: Record<'claude' | 'git', SourceStatus> & Partial<Record<'opencode' | 'codex' | 'docs', SourceStatus>>;
}

export interface AiTask {
  /** One or two sentences summarising the whole task: becomes the log text. */
  text: string;
  /** Short steps done inside the task: become the log's underlying tasks. */
  subtasks?: string[];
  itemIds: string[];
}

export interface SuggestResponse {
  tasks: AiTask[] | null;
  notice?: string;
  apiKeyMissing?: boolean;
}

export interface Suggestion {
  /** Stable for React: the first item id. */
  key: string;
  folder: string;
  projectId: string;
  projectName: string;
  text: string;
  subtasks: string[];
  minutes: number;
  itemIds: string[];
  /** e.g. "3 commits, 2 Claude sessions" */
  evidence: string;
  /** Logged minutes plus not-yet-logged timer time, same date and project. */
  trackedMinutes: number;
}
