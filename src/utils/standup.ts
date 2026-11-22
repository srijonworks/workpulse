import type { BacklogTask, Project, StandupRecord, WorkLog } from '../types';
import { addDays, localDateOfIso, localTimeStr, parseLocalDate } from './dates';
import { redactSecrets, clip } from './activity/sanitize';

export interface StandupPeriod {
  id: string;
  kind: 'day' | 'week';
  from: string;
  to: string;
  label: string;
}

export const MAX_CONTEXT_LOGS = 40;
export const MAX_LOG_CHARS = 300;
export const MAX_CONTEXT_CHARS = 12_000;

const THURSDAY = 4;

export const isWeekClose = (date: string): boolean => parseLocalDate(date).getDay() === THURSDAY;

/** The week ending on this Thursday: Friday to Thursday. */
export function weekWindow(thursday: string): { from: string; to: string } {
  return { from: addDays(thursday, -6), to: thursday };
}

const short = (date: string) =>
  parseLocalDate(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

export const dayPeriod = (date: string): StandupPeriod => ({
  id: `day:${date}`,
  kind: 'day',
  from: date,
  to: date,
  label: short(date),
});

export function weekPeriod(thursday: string): StandupPeriod {
  const { from, to } = weekWindow(thursday);
  return { id: `week:${thursday}`, kind: 'week', from, to, label: `week of ${short(from)} to ${short(to)}` };
}

/** The standups owed for a closed day: always the day, and on a Thursday also the week. */
export function standupPeriod(date: string): { day: StandupPeriod; week?: StandupPeriod } {
  return isWeekClose(date) ? { day: dayPeriod(date), week: weekPeriod(date) } : { day: dayPeriod(date) };
}

export function standupContext(i: {
  logs: WorkLog[];
  tasks: BacklogTask[];
  from: string;
  to: string;
  dayStandups?: StandupRecord[];
}): string {
  const inRange = (d: string) => d >= i.from && d <= i.to;
  const logs = i.logs
    .filter((l) => inRange(l.date))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .slice(0, MAX_CONTEXT_LOGS);
  const tasks = i.tasks.filter((t) => t.dueDate && inRange(t.dueDate) && t.stage !== 'done' && !t.completed);

  const parts: string[] = [
    i.from === i.to ? `Period: ${i.from}` : `Period: ${i.from} to ${i.to} (inclusive)`,
  ];
  const days = (i.dayStandups ?? []).filter((s) => s.kind === 'day' && inRange(s.from)).sort((a, b) => a.from.localeCompare(b.from));
  if (days.length > 0) {
    parts.push('Daily standups already written:');
    for (const s of days) parts.push(`${s.from}: ${clip(s.text.replace(/\s+/g, ' ').trim(), 1200)}`);
  }
  parts.push('Work logs:');
  for (const l of logs) {
    const mins = l.durationMinutes ? ` (${l.durationMinutes}m)` : '';
    parts.push(clip(`${l.date} [${l.status}] ${l.projectName}: ${l.description.replace(/\s+/g, ' ')}${mins}`, MAX_LOG_CHARS));
  }
  if (tasks.length > 0) {
    parts.push('Still open in this period:');
    for (const t of tasks.slice(0, 20)) parts.push(clip(`${t.dueDate} ${t.title}`, 160));
  }
  return clip(redactSecrets(parts.join('\n')), MAX_CONTEXT_CHARS);
}

/**
 * What a standup is written from: the period's logs and the tasks done in it, as one list. A done task already covered by a
 * log (the log was made from it, lists it as a sub-task, or has the same text) is not listed twice. Done tasks become
 * log-shaped entries (id "task:<id>", tracked minutes). The writers turn each log's sub-tasks into sub-points.
 */
export function standupEntries(i: { logs: WorkLog[]; tasks: BacklogTask[]; projects: Project[]; from: string; to: string }): WorkLog[] {
  const inRange = (d: string) => d >= i.from && d <= i.to;
  const logs = i.logs.filter((l) => inRange(l.date));
  const covered = new Set<string>();
  const texts = new Set<string>();
  for (const l of logs) {
    for (const s of l.sourceIds ?? []) if (s.startsWith('task:')) covered.add(s.slice(5));
    for (const u of l.underlyingTasks ?? []) covered.add(u.id);
    texts.add(l.description.trim().toLowerCase());
  }
  const names = new Map(i.projects.map((p) => [p.id, p.name]));
  const done: WorkLog[] = [];
  for (const t of i.tasks) {
    if (!(t.stage === 'done' || t.completed)) continue;
    const day = t.completedAt ? localDateOfIso(t.completedAt) : t.dueDate;
    if (!day || !inRange(day) || covered.has(t.id) || texts.has(t.title.trim().toLowerCase())) continue;
    done.push({
      id: `task:${t.id}`,
      date: day,
      time: t.completedAt ? localTimeStr(new Date(t.completedAt)) : '',
      projectId: t.projectId,
      projectName: names.get(t.projectId) ?? 'General',
      description: t.title,
      status: 'completed',
      tags: [],
      durationMinutes: Math.floor((t.elapsedSeconds ?? 0) / 60) || undefined,
      createdAt: t.completedAt ?? '',
    });
  }
  return [...logs, ...done].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/** Replaces the record with the same id, or adds it. */
export function upsertStandup(list: StandupRecord[], rec: StandupRecord): StandupRecord[] {
  const has = list.some((s) => s.id === rec.id);
  return has ? list.map((s) => (s.id === rec.id ? rec : s)) : [...list, rec];
}
