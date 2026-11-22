import type { BacklogTask } from '../types';
import { getTaskStage } from '../components/tasks/helpers';
import { isRunningTask } from './timerStore';
import { isPendingTask } from './taskLogging';
import { addDays, lastNDays, localDateOfIso, parseLocalDate } from './dates';

export interface DayGroup {
  date: string;
  tasks: BacklogTask[];
}

/**
 * The Plan screen's groups. A pending task is in exactly one date group, whatever its stage
 * (the stage shows on the row); done tasks are only in `done`.
 */
export interface TaskSections {
  /** Pending, not running, due before today: newest date first. */
  overdue: BacklogTask[];
  /** Pending tasks due today, plus anything running (a running task belongs to today). */
  today: BacklogTask[];
  /** Due tomorrow. */
  tomorrow: BacklogTask[];
  /** Due 2 to 6 days from today, oldest first. */
  thisWeek: BacklogTask[];
  /** Due 7 or more days from today, oldest first. */
  later: BacklogTask[];
  /** Done in the last 7 local days (today included), newest first. */
  done: BacklogTask[];
}

const DONE_WINDOW_DAYS = 7;
const WEEK_DAYS = 7;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon 9 Nov" for a local YYYY-MM-DD. */
export function dayLabelLong(dateStr: string): string {
  const d = parseLocalDate(dateStr);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// Running first, then paused / not-started in-progress, then planned; list order within a group.
const rank = (t: BacklogTask): number => {
  if (isRunningTask(t)) return 0;
  return getTaskStage(t) === 'planned' ? 2 : 1;
};
const byRank = (list: BacklogTask[]): BacklogTask[] =>
  list
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);

/** A pending task that has not been started. A running task never counts as a plan. */
export const isPlanned = (t: BacklogTask): boolean =>
  isPendingTask(t) && !isRunningTask(t) && getTaskStage(t) === 'planned';

const groupByDate = (list: BacklogTask[], newestFirst: boolean): DayGroup[] => {
  const byDate = new Map<string, BacklogTask[]>();
  for (const t of list) byDate.set(t.dueDate, [...(byDate.get(t.dueDate) ?? []), t]);
  return [...byDate.entries()]
    .sort(([a], [b]) => (a === b ? 0 : (a < b) === newestFirst ? 1 : -1))
    .map(([date, tasks]) => ({ date, tasks: byRank(tasks) }));
};

/** Planned tasks due before today, grouped by date, newest first. */
export function earlierPlans(backlog: BacklogTask[], today: string): DayGroup[] {
  return groupByDate(backlog.filter((t) => isPlanned(t) && t.dueDate < today), true);
}

/** Splits the backlog into the Plan screen's date groups for a local date. */
export function groupTasks(backlog: BacklogTask[], today: string): TaskSections {
  const pending: BacklogTask[] = [];
  const recent: { t: BacklogTask; at: string }[] = [];
  const windowStart = lastNDays(today, DONE_WINDOW_DAYS)[0];

  for (const t of backlog) {
    if (isPendingTask(t)) {
      pending.push(t);
      continue;
    }
    const at = t.completedAt ?? t.dueDate;
    const day = t.completedAt ? localDateOfIso(t.completedAt) : t.dueDate;
    if (day >= windowStart && day <= today) recent.push({ t, at });
  }

  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, WEEK_DAYS - 1);
  const isToday = (t: BacklogTask) => isRunningTask(t) || t.dueDate === today;
  const rest = pending.filter((t) => !isToday(t));
  const flat = (list: BacklogTask[], newestFirst: boolean) => groupByDate(list, newestFirst).flatMap((d) => d.tasks);
  return {
    overdue: flat(rest.filter((t) => t.dueDate < today), true),
    today: byRank(pending.filter(isToday)),
    tomorrow: byRank(rest.filter((t) => t.dueDate === tomorrow)),
    thisWeek: flat(rest.filter((t) => t.dueDate > tomorrow && t.dueDate <= weekEnd), false),
    later: flat(rest.filter((t) => t.dueDate > weekEnd), false),
    // ISO timestamps and YYYY-MM-DD strings both sort as text; newest first.
    done: recent.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map(({ t }) => t),
  };
}

const SECTION_KEYS = ['overdue', 'today', 'tomorrow', 'thisWeek', 'later', 'done'] as const;

/** The projects with at least one task on the screen (open or done). */
export function sectionProjectIds(s: TaskSections): string[] {
  return [...new Set(SECTION_KEYS.flatMap((k) => s[k]).map((t) => t.projectId))];
}

/** Only one project's tasks (null = all), in every group. */
export function filterByProject(s: TaskSections, projectId: string | null): TaskSections {
  if (!projectId) return s;
  const out = {} as TaskSections;
  for (const k of SECTION_KEYS) out[k] = s[k].filter((t) => t.projectId === projectId);
  return out;
}
