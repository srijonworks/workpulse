import type { BacklogTask, Project, ThemeId, WidgetsSettings, WorkLog, Workdays } from '../types';
import { getTaskStage } from '../components/tasks/helpers';
import { currentWorkday, DEFAULT_WORKDAY_HOURS, validWorkdayHours } from './workday';
import { isPendingTask } from './taskLogging';
import { splitProjectTag } from './projects';
import { isRunningTask, liveSecondsOf } from './timerStore';

// What the desktop widgets show. The app builds this and sends it to the widget windows (Electron only);
// the widgets draw it and send back "start / pause / resume this task". Plain data, no React or window.

export type WidgetKind = 'time' | 'tasks';
export const WIDGET_KINDS: WidgetKind[] = ['time', 'tasks'];

export interface WidgetConfig {
  time: { on: boolean; top: boolean };
  tasks: { on: boolean; top: boolean };
}

/** Both widgets off by default; "on top" is the default placement once one is on. */
export function widgetConfig(w: WidgetsSettings | undefined): WidgetConfig {
  return {
    time: { on: w?.time?.on === true, top: w?.time?.top !== false },
    tasks: { on: w?.tasks?.on === true, top: w?.tasks?.top !== false },
  };
}

export type WidgetTaskState = 'running' | 'paused' | 'blocked' | 'planned';

export interface WidgetTask {
  id: string;
  title: string;
  project: string;
  color: string;
  state: WidgetTaskState;
  /** Tracked seconds when the snapshot was made; a running task keeps counting from `WidgetSnapshot.at`. */
  seconds: number;
}

export interface WidgetSnapshot {
  theme: ThemeId;
  /** Date.now() when this was built. */
  at: number;
  hours: number;
  clockIn: string | null;
  clockOut: string | null;
  /** The local date the snapshot was made for. */
  date: string;
  /** Minutes logged today (all logs dated `date`). */
  loggedMinutes: number;
  /** Plain sentences about things that need attention (a failed backup, a day with no clock-out). Empty = fine. */
  problems: string[];
  tasks: WidgetTask[];
}

export type WidgetCommand =
  | { type: 'start' | 'pause' | 'resume'; id: string }
  | { type: 'clock-in' }
  | { type: 'end-day' }
  | { type: 'add-task'; text: string }
  | { type: 'set-widget'; kind: WidgetKind; on: boolean }
  | { type: 'open' }
  | { type: 'close'; kind: WidgetKind };

const RANK: Record<WidgetTaskState, number> = { running: 0, paused: 1, blocked: 2, planned: 3 };
const MAX_TASKS = 30;
const MAX_PROBLEMS = 3;

/** The main window re-sends at least every 30 s; a snapshot older than this means it stopped. */
export const STALE_AFTER_MS = 90_000;
export const isSnapshotStale = (s: WidgetSnapshot, nowMs: number): boolean => nowMs - s.at > STALE_AFTER_MS;

/** A line typed in the Tasks widget: a trailing "#project" picks the project (like Today's quick add). */
export function parseWidgetTask(text: string, projects: Project[]): { title: string; projectId?: string } | null {
  const { text: title, project } = splitProjectTag(text.trim().slice(0, 300), projects);
  if (!title) return null;
  return project ? { title, projectId: project.id } : { title };
}

/** Open work: running, paused and blocked tasks of any date, and planned tasks due today or earlier. */
export function buildWidgetSnapshot(input: {
  theme: ThemeId;
  backlog: BacklogTask[];
  projects: Project[];
  workdays: Workdays;
  workdayHours: number | undefined;
  today: string;
  nowMs: number;
  logs?: WorkLog[];
  problems?: string[];
}): WidgetSnapshot {
  const { backlog, projects, workdays, today } = input;
  const byId = new Map(projects.map((p) => [p.id, p]));
  const tasks: WidgetTask[] = [];
  for (const t of backlog) {
    if (!isPendingTask(t)) continue;
    const stage = getTaskStage(t);
    const state: WidgetTaskState = isRunningTask(t)
      ? 'running'
      : stage === 'blocked'
        ? 'blocked'
        : stage === 'planned'
          ? 'planned'
          : 'paused';
    if (state === 'planned' && t.dueDate > today) continue;
    const p = byId.get(t.projectId);
    tasks.push({
      id: t.id,
      title: t.title,
      project: p && !p.trashedAt ? p.name : '',
      color: p && !p.trashedAt ? p.color : '',
      state,
      seconds: Math.floor(liveSecondsOf(t)),
    });
  }
  tasks.sort((a, b) => RANK[a.state] - RANK[b.state]);
  const day = currentWorkday(workdays, today);
  return {
    theme: input.theme,
    at: input.nowMs,
    hours: validWorkdayHours(input.workdayHours) ?? DEFAULT_WORKDAY_HOURS,
    clockIn: day?.rec.clockIn ?? null,
    clockOut: day?.rec.clockOut ?? null,
    date: today,
    loggedMinutes: (input.logs ?? []).reduce((sum, l) => (l.date === today ? sum + (l.durationMinutes ?? 0) : sum), 0),
    problems: (input.problems ?? []).slice(0, MAX_PROBLEMS),
    tasks: tasks.slice(0, MAX_TASKS),
  };
}

/** Everything in a snapshot except the moment it was built and the live seconds of running tasks. */
export function snapshotSignature(s: WidgetSnapshot): string {
  return JSON.stringify([
    s.theme,
    s.hours,
    s.clockIn,
    s.clockOut,
    s.date,
    s.loggedMinutes,
    s.problems,
    s.tasks.map((t) => [t.id, t.title, t.project, t.color, t.state, t.state === 'running' ? 0 : t.seconds]),
  ]);
}
