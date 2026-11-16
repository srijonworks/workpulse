import { localTimeStr } from '../dates';
import { minutesFromSeconds } from '../duration';
import { unloggedSeconds } from '../taskLogging';
import { clusterTimes } from './time';
import type { BacklogTask, Project, WorkLog } from '../../types';
import type { ActivityFolder, ActivityItem, AiTask, Suggestion } from './types';

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** Every activity item id already used by a saved log. */
export function consumedIds(logs: WorkLog[]): Set<string> {
  const ids = new Set<string>();
  for (const l of logs) for (const id of l.sourceIds ?? []) ids.add(id);
  return ids;
}

export function dropConsumed(items: ActivityItem[], consumed: Set<string>): ActivityItem[] {
  return items.filter((i) => !consumed.has(i.id));
}

const TASK_PREFIX = 'task:';
/** The backlog task ids among a suggestion's item ids ("task:<id>"). */
export function taskIdsOf(itemIds: string[]): string[] {
  return itemIds.filter((id) => id.startsWith(TASK_PREFIX)).map((id) => id.slice(TASK_PREFIX.length));
}

/** The synthetic "folder" of a done task whose project has no linked folder. */
export const projectFolderKey = (projectId: string): string => `project:${projectId}`;

/**
 * Done tasks with time waiting to be logged, as activity items, so one grouping step handles them
 * together with commits and prompts. A task sits in a folder linked to its project when there is one
 * (so it groups with that project's commits), else in a "project:<id>" key.
 */
export function taskItems(tasks: BacklogTask[], folders: ActivityFolder[], nowIso: string = new Date().toISOString()): ActivityItem[] {
  return tasks.map((t) => {
    const linked = folders.find((f) => f.projectId === t.projectId);
    return {
      id: `${TASK_PREFIX}${t.id}`,
      source: 'task' as const,
      folder: linked ? linked.path : projectFolderKey(t.projectId),
      time: t.completedAt ?? t.startedAt ?? nowIso,
      text: t.title.slice(0, 200),
    };
  });
}

/**
 * Minutes already on record for a project on a date: logged durations plus tracked timer time
 * not yet written into a log. Time already written into a log is counted once, through the log.
 */
export function trackedMinutesFor(
  date: string,
  projectId: string,
  logs: WorkLog[],
  backlog: BacklogTask[],
  /** Tasks the suggestion itself is about to log: their timer time is not "already on record". */
  excludeTaskIds: ReadonlySet<string> = new Set(),
): number {
  let total = 0;
  for (const l of logs) if (l.date === date && l.projectId === projectId) total += l.durationMinutes ?? 0;
  for (const t of backlog) {
    if (t.projectId === projectId && t.dueDate === date && !excludeTaskIds.has(t.id)) total += minutesFromSeconds(unloggedSeconds(t));
  }
  return total;
}

function evidenceOf(items: ActivityItem[]): string {
  const commits = items.filter((i) => i.source === 'git').length;
  const sessionsOf = (source: string) => new Set(items.filter((i) => i.source === source).map((i) => i.id.split(':')[1])).size;
  const sessions = sessionsOf('claude');
  const openCode = sessionsOf('opencode');
  const codex = sessionsOf('codex');
  const doneTasks = items.filter((i) => i.source === 'task').length;
  const parts: string[] = [];
  if (doneTasks > 0) parts.push(`${doneTasks} done ${doneTasks === 1 ? 'task' : 'tasks'}`);
  if (commits > 0) parts.push(`${commits} commit${commits === 1 ? '' : 's'}`);
  if (sessions > 0) parts.push(`${sessions} Claude session${sessions === 1 ? '' : 's'}`);
  if (openCode > 0) parts.push(`${openCode} OpenCode session${openCode === 1 ? '' : 's'}`);
  if (codex > 0) parts.push(`${codex} Codex session${codex === 1 ? '' : 's'}`);
  return parts.join(', ') || 'activity';
}

/**
 * Turns tasks (text + item ids) into suggestions. A task that spans several projects is split into
 * one suggestion per project, and folders that map to the same project end up together. Minutes,
 * project and evidence always come from the items themselves, never from the AI.
 */
export function buildSuggestions(
  tasks: AiTask[],
  items: ActivityItem[],
  args: { date: string; folders: ActivityFolder[]; projects: Project[]; logs: WorkLog[]; backlog: BacklogTask[] },
): Suggestion[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const projectOfFolder = (folder: string) =>
    folder.startsWith('project:') ? folder.slice('project:'.length) : (args.folders.find((f) => f.path === folder)?.projectId ?? '');

  // One group per (task, project), in task order.
  const groups: { projectId: string; task: AiTask; items: ActivityItem[] }[] = [];
  for (const task of tasks) {
    const byProject = new Map<string, ActivityItem[]>();
    for (const id of task.itemIds) {
      const it = byId.get(id);
      if (!it) continue;
      const projectId = projectOfFolder(it.folder);
      byProject.set(projectId, [...(byProject.get(projectId) ?? []), it]);
    }
    for (const [projectId, group] of byProject) {
      groups.push({ projectId, task, items: [...group].sort((a, b) => a.time.localeCompare(b.time)) });
    }
  }

  const activityMinutes = minutesPerGroup(groups);
  const minutes = groups.map((g, i) => Math.max(activityMinutes[i], timerMinutesOf(g.items, args.backlog)));
  return groups.map((g, i) => ({
    key: g.items[0].id,
    folder: g.items[0].folder,
    projectId: g.projectId,
    projectName: args.projects.find((p) => p.id === g.projectId)?.name ?? 'Unassigned',
    text: g.task.text,
    subtasks: g.task.subtasks ?? [],
    minutes: minutes[i],
    itemIds: g.items.map((x) => x.id),
    evidence: evidenceOf(g.items),
    trackedMinutes: trackedMinutesFor(args.date, g.projectId, args.logs, args.backlog, new Set(taskIdsOf(g.items.map((x) => x.id)))),
  }));
}

/**
 * Estimated minutes for each group. The AI may interleave one stretch of work across several
 * tasks, so a project's time is clustered once from all of its items and each cluster's minutes are
 * shared between the groups by how many of its items they hold. The groups of a project then add up to
 * that project's real total instead of each counting the same hour again.
 */
function minutesPerGroup(groups: { projectId: string; items: ActivityItem[] }[]): number[] {
  const result: number[] = new Array(groups.length).fill(0);
  const byProject = new Map<string, number[]>();
  groups.forEach((g, i) => byProject.set(g.projectId, [...(byProject.get(g.projectId) ?? []), i]));

  for (const indexes of byProject.values()) {
    const unique = new Map<string, ActivityItem>();
    for (const i of indexes) for (const it of groups[i].items) if (it.source !== 'task') unique.set(it.id, it);
    const clusters = clusterTimes([...unique.values()].map((it) => it.time));
    const clusterOf = (iso: string) => {
      const t = new Date(iso).getTime();
      return clusters.findIndex((c) => t >= c.start && t <= c.end);
    };
    const itemsIn = clusters.map(() => 0);
    for (const it of unique.values()) itemsIn[clusterOf(it.time)]++;

    const share = indexes.map(() => 0);
    indexes.forEach((gi, k) => {
      for (const it of groups[gi].items) {
        if (it.source === 'task') continue;
        const c = clusterOf(it.time);
        share[k] += clusters[c].minutes / itemsIn[c];
      }
    });

    // Whole minutes that add up exactly to the project's total: the largest fractions get the leftovers.
    const total = clusters.reduce((sum, c) => sum + c.minutes, 0);
    const floors = share.map(Math.floor);
    let leftover = total - floors.reduce((a, b) => a + b, 0);
    const order = share.map((v, k) => k).sort((a, b) => share[b] - Math.floor(share[b]) - (share[a] - Math.floor(share[a])) || a - b);
    for (const k of order) {
      if (leftover <= 0) break;
      floors[k]++;
      leftover--;
    }
    indexes.forEach((gi, k) => (result[gi] = floors[k]));
  }
  return result;
}

/** Tracked timer time (not yet logged) of the done tasks among these items, in minutes. */
function timerMinutesOf(items: ActivityItem[], backlog: BacklogTask[]): number {
  const ids = new Set(taskIdsOf(items.map((i) => i.id)));
  let seconds = 0;
  for (const t of backlog) if (ids.has(t.id)) seconds += unloggedSeconds(t);
  return minutesFromSeconds(seconds);
}

/**
 * The no-AI fallback: one task per folder, "Worked on <project>", with the commit subjects (or, when
 * there are no commits, the user's prompts) as its sub-tasks.
 */
export function templateTasks(items: ActivityItem[], projectNameByFolder: Record<string, string> = {}): AiTask[] {
  const byFolder = new Map<string, ActivityItem[]>();
  for (const it of items) byFolder.set(it.folder, [...(byFolder.get(it.folder) ?? []), it]);

  const distinct = (list: string[]) => [...new Set(list)];
  return [...byFolder].map(([folder, list]) => {
    const commits = distinct(list.filter((i) => i.source === 'git').map((i) => i.text));
    const prompts = distinct(
      list.filter((i) => (i.source === 'claude' || i.source === 'opencode' || i.source === 'codex') && !i.text.startsWith('Session: ') && !i.text.startsWith('Edited ')).map((i) => i.text),
    );
    const taskTitles = distinct(list.filter((i) => i.source === 'task').map((i) => i.text));
    const subtasks = [...taskTitles, ...(commits.length > 0 ? commits : prompts)].slice(0, 12);
    const text = `Worked on ${projectNameByFolder[folder] || baseName(folder)}`;
    const ids = list.map((i) => i.id);
    return subtasks.length > 0 ? { text, subtasks, itemIds: ids } : { text, itemIds: ids };
  });
}

/** The log to save for one ticked suggestion, with whatever the user edited in the dialog. */
export function suggestionToLogData(
  s: Suggestion,
  date: string,
  minutes: number,
  text: string,
  projectId: string,
  projectName: string,
  subtasks: string[],
): Omit<WorkLog, 'id' | 'createdAt'> {
  const steps = subtasks.map((t) => t.trim()).filter((t) => t.length > 0);
  return {
    date,
    time: localTimeStr(),
    projectId,
    projectName,
    description: text,
    status: 'completed',
    tags: [],
    durationMinutes: minutes > 0 ? minutes : undefined,
    sourceIds: [...s.itemIds],
    // The steps shown under the log as "View Underlying Micro-Tasks": done, with no tracked time.
    ...(steps.length > 0
      ? { underlyingTasks: steps.map((title, i) => ({ id: `sub-${s.key}-${i}`, title, stage: 'done' as const, elapsedSeconds: 0 })) }
      : {}),
  };
}
