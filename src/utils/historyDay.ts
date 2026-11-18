import type { BacklogTask, Project, WorkLog, Workdays } from '../types';
import { addDays, localDateOfIso, localTimeStr, parseLocalDate } from './dates';
import { logsToCsv } from './exportLogs';
import { filterLogs, NO_FILTERS } from './logFilter';
import { segmentSecondsInRange } from './segments';

// What History's day panel shows for one local date. Pure: no React, no window.

/** "2026-11-14", "yesterday" or "today" (any case, spaces ignored) as a date; anything else is null. */
export function parseDateQuery(query: string, today: string): string | null {
  const q = query.trim().toLowerCase();
  if (q === 'today') return today;
  if (q === 'yesterday') return addDays(today, -1);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q);
  if (!m) return null;
  const d = parseLocalDate(q);
  const same = d.getFullYear() === +m[1] && d.getMonth() + 1 === +m[2] && d.getDate() === +m[3];
  return same ? q : null;
}

/** Local midnight to the next local midnight, in epoch ms. */
export function dayRangeMs(date: string): { fromMs: number; toMs: number } {
  return { fromMs: parseLocalDate(date).getTime(), toMs: parseLocalDate(addDays(date, 1)).getTime() };
}

export interface DaySummary {
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  /** Clocked in on an earlier date and never clocked out. */
  noClockOut: boolean;
  /** Seconds between clock-in and clock-out (or now, today, while still in); null when it cannot be known. */
  workedSec: number | null;
  loggedMinutes: number;
  /** Seconds the task timers ran on this date, from timer segments. */
  trackedSec: number;
  doneTasks: BacklogTask[];
  logs: WorkLog[];
}

export function summarizeDay(input: {
  date: string;
  today: string;
  nowMs: number;
  logs: WorkLog[];
  workdays: Workdays;
  backlog: BacklogTask[];
}): DaySummary {
  const { date, today, nowMs } = input;
  const rec = input.workdays[date];
  const logs = input.logs.filter((l) => l.date === date).sort((a, b) => a.time.localeCompare(b.time));
  const { fromMs, toMs } = dayRangeMs(date);
  const inMs = rec ? Date.parse(rec.clockIn) : NaN;
  let workedSec: number | null = null;
  if (rec && Number.isFinite(inMs)) {
    if (rec.clockOut) workedSec = Math.max(0, Math.floor((Date.parse(rec.clockOut) - inMs) / 1000));
    else if (date === today) workedSec = Math.max(0, Math.floor((nowMs - inMs) / 1000));
  }
  return {
    date,
    clockIn: rec?.clockIn ?? null,
    clockOut: rec?.clockOut ?? null,
    noClockOut: !!rec && !rec.clockOut && date < today,
    workedSec,
    loggedMinutes: logs.reduce((sum, l) => sum + (l.durationMinutes ?? 0), 0),
    trackedSec: segmentSecondsInRange(input.backlog, fromMs, toMs, nowMs),
    doneTasks: input.backlog.filter(
      (t) => (t.completed === true || t.stage === 'done') && !!t.completedAt && localDateOfIso(t.completedAt) === date,
    ),
    logs,
  };
}

/** "6:12" from seconds (hours:minutes). */
export const hm = (sec: number): string => {
  const m = Math.floor(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

export function dayToCsv(s: DaySummary): string {
  return logsToCsv(s.logs);
}

/** One day as Markdown: times, the day's figures, done tasks, logs, and the saved standup when there is one. */
export function dayToMarkdown(s: DaySummary, projects: Project[], standup?: string): string {
  const byId = new Map(projects.map((p) => [p.id, p.name]));
  const time = (iso: string | null) => (iso ? localTimeStr(new Date(iso)) : '');
  let md = `# ${s.date}\n\n`;
  if (s.clockIn) {
    md += `- Clocked in: ${time(s.clockIn)}\n`;
    md += `- Clocked out: ${s.clockOut ? time(s.clockOut) : 'no clock-out'}\n`;
  } else {
    md += `- No clock-in recorded\n`;
  }
  if (s.workedSec !== null) md += `- Worked: ${hm(s.workedSec)}\n`;
  md += `- Logged: ${hm(s.loggedMinutes * 60)}\n`;
  md += `- Tracked: ${hm(s.trackedSec)}\n\n`;
  md += `## Done tasks\n`;
  md += s.doneTasks.length
    ? s.doneTasks.map((t) => `- ${t.title}${byId.get(t.projectId) ? ` (${byId.get(t.projectId)})` : ''}\n`).join('')
    : `No tasks finished.\n`;
  md += `\n## Logs\n`;
  md += s.logs.length
    ? s.logs
        .map((l) => `- ${l.time} **[${l.projectName}]** ${l.description}${l.durationMinutes ? ` (${l.durationMinutes}m)` : ''}\n`)
        .join('')
    : `Nothing logged.\n`;
  if (standup?.trim()) md += `\n## Standup\n${standup.trim()}\n`;
  return md;
}

// ---- A range of days (History lists one or many days the same way) ----

export interface RangeInput {
  from: string;
  to: string;
  today: string;
  nowMs: number;
  logs: WorkLog[];
  workdays: Workdays;
  backlog: BacklogTask[];
  /** Words to find in logs (description, project, tags) and done-task titles. '' = no search. */
  query?: string;
  /** 'all' or a project id: keeps only that project's logs and tasks. */
  projectId?: string;
}

export interface RangeSummary {
  /** Days that have something to show, newest first. Logs and tasks are already filtered by the search and project. */
  days: DaySummary[];
  logCount: number;
  taskCount: number;
  loggedMinutes: number;
}

const isDone = (t: BacklogTask) => (t.completed === true || t.stage === 'done') && !!t.completedAt;

/**
 * Everything on record between two dates (both included), one summary per day that has a clock-in, a log or a finished task.
 * With a search or a project, days with no matching log or task are left out.
 */
export function summarizeRange(input: RangeInput): RangeSummary {
  const { from, to, today, nowMs } = input;
  const query = (input.query ?? '').trim().toLowerCase();
  const projectId = input.projectId && input.projectId !== 'all' ? input.projectId : null;
  const filtering = query !== '' || projectId !== null;

  const logs = filterLogs(input.logs, { ...NO_FILTERS, query, projectId: projectId ?? 'all' }, today);
  const logsByDate = new Map<string, WorkLog[]>();
  for (const l of logs) logsByDate.set(l.date, [...(logsByDate.get(l.date) ?? []), l]);

  const done = input.backlog.filter(
    (t) => isDone(t) && (!projectId || t.projectId === projectId) && (query === '' || t.title.toLowerCase().includes(query)),
  );
  const dates = new Set<string>(logsByDate.keys());
  for (const t of done) dates.add(localDateOfIso(t.completedAt as string));
  if (!filtering) for (const d of Object.keys(input.workdays)) dates.add(d);

  const days: DaySummary[] = [];
  for (const date of [...dates].filter((d) => d >= from && d <= to).sort((a, b) => b.localeCompare(a))) {
    const s = summarizeDay({ date, today, nowMs, logs: logsByDate.get(date) ?? [], workdays: input.workdays, backlog: input.backlog });
    const tasks = done.filter((t) => localDateOfIso(t.completedAt as string) === date);
    const day = { ...s, doneTasks: tasks };
    if (filtering && day.logs.length === 0 && tasks.length === 0) continue;
    days.push(day);
  }
  return {
    days,
    logCount: days.reduce((n, d) => n + d.logs.length, 0),
    taskCount: days.reduce((n, d) => n + d.doneTasks.length, 0),
    loggedMinutes: days.reduce((n, d) => n + d.loggedMinutes, 0),
  };
}

/** The range as Markdown: each day with its times, done tasks, logs and saved standup. */
export function rangeToMarkdown(days: DaySummary[], projects: Project[], from: string, to: string, standupFor?: (date: string) => string | undefined): string {
  const body = [...days].reverse().map((d) => dayToMarkdown(d, projects, standupFor?.(d.date))).join('\n---\n\n');
  return from === to ? body : `# Work log ${from} to ${to}\n\n${body}`;
}
