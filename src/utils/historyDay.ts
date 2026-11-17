import type { BacklogTask, Project, WorkLog, Workdays } from '../types';
import { addDays, localDateOfIso, localTimeStr, parseLocalDate } from './dates';
import { logsToCsv } from './exportLogs';
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
