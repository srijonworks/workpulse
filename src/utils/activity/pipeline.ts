import { scanActivityApi, suggestTasksApi } from './client';
import { buildSuggestions, consumedIds, dropConsumed, projectFolderKey, taskItems, templateTasks } from './suggestions';
import type { BacklogTask, Project, WorkLog } from '../../types';
import type {
  ActivityFolder,
  ActivitySource,
  ActivitySources,
  ScanRequest,
  ScanResponse,
  SourceStatus,
  SuggestResponse,
  Suggestion,
  ActivityItem,
  ActivityAi,
} from './types';

export interface PipelineArgs {
  date: string;
  folders: ActivityFolder[];
  sources: ActivitySources;
  projects: Project[];
  logs: WorkLog[];
  backlog: BacklogTask[];
  /** Only sent to the server when `ai` is 'gemini'. */
  geminiApiKey: string;
  ai: ActivityAi;
  /** Done tasks with time waiting to be logged: merged with the scanned activity into the same suggestions. */
  tasks?: BacklogTask[];
  /** The `itemsKey` of the last result: when nothing changed since, the AI is not asked again. */
  sameAs?: string;
}

export interface PipelineResult {
  suggestions: Suggestion[];
  status: ScanResponse['status'];
  /** Identifies the items this result was made from (sorted ids), to spot "nothing new" on the next check. */
  itemsKey: string;
  /** True when `sameAs` matched: the result carries no suggestions and the caller keeps what it has. */
  unchanged?: boolean;
  /** Set when the AI was not used: why, in a plain sentence. */
  notice?: string;
}

interface Deps {
  scan: (req: ScanRequest) => Promise<ScanResponse>;
  suggest: (args: { items: ActivityItem[]; projectNameByFolder: Record<string, string>; customApiKey: string; provider: 'claude' | 'gemini' }) => Promise<SuggestResponse>;
}

const REAL: Deps = { scan: scanActivityApi, suggest: suggestTasksApi };

/**
 * The whole flow behind the dialog: read the day's activity, drop what a saved log already used,
 * let the AI group it (plain wording when it can't), and build the suggestions. A failed scan
 * throws (the dialog shows it); a failed AI call never does.
 */
export async function loadSuggestions(args: PipelineArgs, deps: Deps = REAL): Promise<PipelineResult> {
  const canScan = args.folders.length > 0 && (args.sources.claude || args.sources.git || args.sources.opencode || args.sources.codex);
  const empty: ScanResponse = {
    items: [],
    status: { claude: { ok: true, count: 0, note: 'Turned off in Settings' }, git: { ok: true, count: 0, note: 'Turned off in Settings' } },
  };
  const scanned = canScan ? await deps.scan({ date: args.date, folders: args.folders, sources: args.sources }) : empty;
  const tasks = (args.tasks ?? []).filter((t) => args.projects.some((p) => p.id === t.projectId));
  const items = dropConsumed([...scanned.items, ...taskItems(tasks, args.folders)], consumedIds(args.logs));
  const itemsKey = items.map((i) => i.id).sort().join('|');
  if (items.length === 0) return { suggestions: [], status: scanned.status, itemsKey };
  if (args.sameAs !== undefined && args.sameAs === itemsKey) return { suggestions: [], status: scanned.status, itemsKey, unchanged: true };

  const projectNameByFolder: Record<string, string> = {};
  for (const f of args.folders) {
    projectNameByFolder[f.path] = args.projects.find((p) => p.id === f.projectId)?.name ?? 'Unassigned';
  }
  for (const t of tasks) projectNameByFolder[projectFolderKey(t.projectId)] = args.projects.find((p) => p.id === t.projectId)?.name ?? 'Unassigned';

  let aiTasks = null as SuggestResponse['tasks'];
  let notice: string | undefined;
  // "none" is a choice, not a failure: no AI call and no notice.
  if (args.ai !== 'none') {
    try {
      const answer = await deps.suggest({
        items,
        projectNameByFolder,
        provider: args.ai,
        customApiKey: args.ai === 'gemini' ? args.geminiApiKey : '',
      });
      aiTasks = answer.tasks;
      notice = answer.notice;
    } catch (err) {
      const why = err instanceof Error ? err.message : 'The AI could not be reached.';
      notice = `${why} Showing plain wording instead.`;
    }
  }

  const suggestions = buildSuggestions(aiTasks ?? templateTasks(items, projectNameByFolder), items, {
    date: args.date,
    folders: args.folders,
    projects: args.projects,
    logs: args.logs,
    backlog: args.backlog,
  });
  return { suggestions, status: scanned.status, itemsKey, notice: aiTasks ? undefined : notice };
}

const LABEL: Record<ActivitySource, string> = { claude: 'Claude Code prompts', git: 'Git commits', opencode: 'OpenCode prompts', codex: 'Codex prompts' };

/** One plain line per switched-on source: how much was found, and any note about it. */
export function describeSources(sources: ActivitySources, status: Partial<Record<ActivitySource, SourceStatus>>): string[] {
  const lines: string[] = [];
  for (const source of ['claude', 'git', 'opencode', 'codex'] as const) {
    if (!sources[source]) continue;
    const s = status[source];
    if (!s) continue;
    const head = !s.ok ? "couldn't read." : s.count === 0 ? 'nothing found.' : `${s.count} found.`;
    lines.push(`${LABEL[source]}: ${head}${s.note ? ` ${s.note}` : ''}`);
  }
  return lines;
}

/**
 * Identifies what the data notice covered: which sources are read and which AI gets the text. The
 * notice is shown again when either changes, because the data then goes somewhere new.
 */
export function noticeSignature(sources: ActivitySources, ai: ActivityAi): string {
  // OpenCode and Codex are added only when on, so a notice agreed to before they existed stays valid until they are switched on.
  return `${[sources.git ? 'git' : '', sources.claude ? 'claude' : '', sources.opencode ? 'opencode' : '', sources.codex ? 'codex' : ''].filter(Boolean).join('+')}|${ai}`;
}
