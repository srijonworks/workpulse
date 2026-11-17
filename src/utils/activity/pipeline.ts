import { scanActivityApi, suggestTasksApi } from './client';
import { isNoise, scoreCluster, type DetailLevel } from './significance';
import { ACTIVITY_SOURCES, byDisplayRank, type SourceDescriptor } from './registry';
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
  /**
   * Which work is worth a log. Without it every suggestion is returned as before. With it, trivial items are dropped, and
   * each suggestion is a log, a "maybe" (too small for its own log for now) or skipped.
   */
  quality?: { smallestLogMinutes?: number; detail?: DetailLevel; boostFor?: (projectId: string) => number };
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
  /** Work close to the line: too small for a log now. A later scan may find more of it, and then it becomes a log. */
  maybe?: Suggestion[];
  /** How many small or trivial pieces of work were left out (the System status screen shows the day's count). */
  skipped?: number;
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
  const canScan = args.folders.length > 0 && ACTIVITY_SOURCES.some((d) => args.sources[d.id as ActivitySource]);
  const empty: ScanResponse = {
    items: [],
    status: { claude: { ok: true, count: 0, note: 'Turned off in Settings' }, git: { ok: true, count: 0, note: 'Turned off in Settings' } },
  };
  const scanned = canScan ? await deps.scan({ date: args.date, folders: args.folders, sources: args.sources }) : empty;
  const tasks = (args.tasks ?? []).filter((t) => args.projects.some((p) => p.id === t.projectId));
  const all = dropConsumed([...scanned.items, ...taskItems(tasks, args.folders)], consumedIds(args.logs));
  // Trivial items (a merge commit, "yes", "wip") never reach the AI; done tasks always count.
  const items = args.quality ? all.filter((i) => i.source === 'task' || !isNoise(i)) : all;
  const noise = all.length - items.length;
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
  if (!args.quality) return { suggestions, status: scanned.status, itemsKey, notice: aiTasks ? undefined : notice };

  // Which suggestions are worth a log of their own.
  const byId = new Map(items.map((i) => [i.id, i]));
  const logsOut: Suggestion[] = [];
  const maybe: Suggestion[] = [];
  let skipped = noise;
  for (const s of suggestions) {
    const cluster = { items: s.itemIds.map((id) => byId.get(id)).filter((i): i is ActivityItem => !!i), minutes: s.minutes };
    const level = scoreCluster(cluster, {
      smallestLogMinutes: args.quality.smallestLogMinutes,
      detail: args.quality.detail,
      boost: args.quality.boostFor?.(s.projectId),
    }).level;
    if (level === 'log') logsOut.push(s);
    else if (level === 'maybe') maybe.push(s);
    else skipped++;
  }
  return { suggestions: logsOut, maybe, skipped, status: scanned.status, itemsKey, notice: aiTasks ? undefined : notice };
}

/** One plain line per switched-on source: how much was found, and any note about it. */
export function describeSources(
  sources: ActivitySources,
  status: Partial<Record<ActivitySource, SourceStatus>>,
  registry: readonly SourceDescriptor[] = ACTIVITY_SOURCES,
): string[] {
  const lines: string[] = [];
  for (const d of registry) {
    if (!(sources as Record<string, boolean | undefined>)[d.id]) continue;
    const s = (status as Record<string, SourceStatus | undefined>)[d.id];
    if (!s) continue;
    const head = !s.ok ? "couldn't read." : s.count === 0 ? 'nothing found.' : `${s.count} found.`;
    lines.push(`${d.label}: ${head}${s.note ? ` ${s.note}` : ''}`);
  }
  return lines;
}

/**
 * Identifies what the data notice covered: which sources are read and which AI gets the text. The
 * notice is shown again when either changes, because the data then goes somewhere new.
 */
export function noticeSignature(sources: ActivitySources, ai: ActivityAi, registry: readonly SourceDescriptor[] = ACTIVITY_SOURCES): string {
  // Only sources that are on appear, in a fixed order, so a notice agreed to before a source existed stays valid until it is switched on.
  const on = byDisplayRank(registry).filter((d) => (sources as Record<string, boolean | undefined>)[d.id]);
  return `${on.map((d) => d.id).join('+')}|${ai}`;
}
