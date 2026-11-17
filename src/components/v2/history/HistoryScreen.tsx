import React, { useEffect, useId, useMemo, useState } from 'react';
import { DatePicker } from '../../ui/DatePicker';
import { Select } from '../../ui/Select';
import type { BacklogTask, Project, WorkLog, Workdays } from '../../../types';
import { addDays, localDateStr, localTimeStr } from '../../../utils/dates';
import { filterLogs, NO_FILTERS } from '../../../utils/logFilter';
import { weekDays, weekTotals } from '../../../utils/weekTotals';
import { dayLabelLong } from '../../../utils/taskSections';
import { logsToCsv, logsToMarkdown } from '../../../utils/exportLogs';
import { dayToCsv, dayToMarkdown, hm, parseDateQuery, summarizeDay } from '../../../utils/historyDay';
import { sameTasksIgnoringLiveTime } from '../../../utils/timerStore';
import { useNow } from '../useNow';
import { LogRow, formatMinutes } from '../today/LogRow';
import { RowMenu } from '../RowMenu';
import { WeekStrip } from './WeekStrip';
import { SyncButton, type SyncState } from '../SyncButton';

export interface HistoryScreenProps {
  logs: WorkLog[];
  projects: Project[];
  workdays: Workdays;
  /** Tasks: the day panel lists the day's done tasks and its tracked time. */
  backlog: BacklogTask[];
  /** The day the panel shows (a local date). App keeps it so it survives tab switches. */
  selectedDay: string;
  onSelectDay(date: string): void;
  /** The saved standup text of a date, when there is one (shown in the day panel with Copy). */
  standupFor?(date: string): string | undefined;
  /** Workday length in hours (the week strip's target line). */
  hours: number;
  onEditLog(log: WorkLog): void;
  onDeleteLog(id: string): void;
  onDuplicateLog(log: WorkLog): void;
  /** Copies text to the clipboard and says so (App owns the toast). */
  onCopy(text: string): void;
  selectedIds: string[];
  onToggleSelect(id: string): void;
  onSelectMany(ids: string[]): void;
  onClearSelection(): void;
  /** Open the standup dialog for the selected logs. */
  onStandup(): void;
  onOpenImage(base64: string): void;
  /** The Sync button's state (memoized in App). */
  sync: SyncState;
  /** A log to show (picked in the search palette): the strip jumps to its day and the row is scrolled to. */
  focusDate?: string;
  focusLogId?: string;
  /** Called once the focus request was taken, so App can clear it. */
  onFocusHandled?(): void;
}

const LABEL = 'block mb-1 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]';
const FIELD = 'v2-input w-full h-11 px-3 text-[length:var(--fs-body)]';
const TEXT_BTN =
  'min-h-8 pointer-coarse:min-h-11 px-1 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] underline underline-offset-4 cursor-pointer';

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number) => `${n} ${n === 1 ? 'log' : 'logs'}`;

/** "9 – 15 Nov", or "28 Oct – 3 Nov" across a month. */
function weekRange(days: string[]): string {
  const [, m1, d1] = days[0].split('-').map(Number);
  const [, m2, d2] = days[6].split('-').map(Number);
  return m1 === m2 ? `${d1} – ${d2} ${MONTH[m2 - 1]}` : `${d1} ${MONTH[m1 - 1]} – ${d2} ${MONTH[m2 - 1]}`;
}

function download(text: string, name: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const HistoryScreenView: React.FC<HistoryScreenProps> = ({
  logs,
  projects,
  workdays,
  backlog,
  selectedDay,
  onSelectDay,
  standupFor,
  hours,
  onEditLog,
  onDeleteLog,
  onDuplicateLog,
  onCopy,
  selectedIds,
  onToggleSelect,
  onSelectMany,
  onClearSelection,
  onStandup,
  onOpenImage,
  sync,
  focusDate,
  focusLogId,
  onFocusHandled,
}) => {
  const id = useId();
  const today = localDateStr();
  const [anchor, setAnchor] = useState(today);
  const now = useNow(30_000);
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('all');

  // A log picked in the search palette: show its day with no search or project filter, then scroll to it.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!focusDate || !focusLogId) return;
    setAnchor(focusDate);
    onSelectDay(focusDate);
    setQuery('');
    setProjectId('all');
    setScrollTo(focusLogId);
    onFocusHandled?.();
  }, [focusDate, focusLogId, onFocusHandled, onSelectDay]);

  // The strip follows the picked day (date box, Yesterday, search by date).
  useEffect(() => setAnchor(selectedDay), [selectedDay]);

  const days = useMemo(() => weekDays(anchor), [anchor]);
  const totals = useMemo(() => weekTotals(logs, days), [logs, days]);
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const thisWeek = days.includes(today);
  const lastWeek = !thisWeek && days.includes(addDays(today, -7));
  const range = weekRange(days);
  const label = thisWeek ? `This week · ${range}` : lastWeek ? `Last week · ${range}` : range;

  // Projects that have logs, so the filter offers only what can match.
  const usedIds = useMemo(() => new Set(logs.map((l) => l.projectId)), [logs]);
  const filterProjects = projects.filter((p) => usedIds.has(p.id));
  const activeProject = projectId !== 'all' && usedIds.has(projectId) ? projectId : 'all';

  // A search looks through every week; otherwise the list is the strip's week (or its picked day).
  const searching = query.trim() !== '';
  const shown = useMemo(() => {
    const hits = filterLogs(logs, { ...NO_FILTERS, query, projectId: activeProject }, today);
    if (searching) return hits;
    // The picked day has its own panel; this list is the rest of the week.
    return hits.filter((l) => l.date >= days[0] && l.date <= days[6] && l.date !== selectedDay);
  }, [logs, query, activeProject, today, searching, selectedDay, days]);

  const groups = useMemo(() => {
    const map = new Map<string, WorkLog[]>();
    [...shown]
      .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time))
      .forEach((l) => map.set(l.date, [...(map.get(l.date) ?? []), l]));
    return [...map];
  }, [shown]);

  // After the list shows the picked log: bring its row into view, flash it once and focus its menu.
  useEffect(() => {
    if (!scrollTo) return;
    setScrollTo(null);
    const row = document.querySelector<HTMLElement>(`.v2-history [data-log-id="${CSS.escape(scrollTo)}"]`);
    if (!row) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    row.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus({ preventScroll: true });
    row.classList.add('log-flash');
    setTimeout(() => row.classList.remove('log-flash'), 1700);
  }, [scrollTo, groups]);

  const shownIds = shown.map((l) => l.id);
  const allPicked = shownIds.length > 0 && shownIds.every((i) => selectedIds.includes(i));
  const selectedLogs = useMemo(() => logs.filter((l) => selectedIds.includes(l.id)), [logs, selectedIds]);

  const moveWeek = (n: number) => setAnchor((a) => addDays(a, n * 7));

  const summary = useMemo(
    () => summarizeDay({ date: selectedDay, today, nowMs: now, logs, workdays, backlog }),
    [selectedDay, today, now, logs, workdays, backlog],
  );
  const standup = standupFor?.(selectedDay);

  // A search that is a date ("2026-11-14", "yesterday", "today") jumps to that day instead.
  const onQuery = (value: string) => {
    const date = parseDateQuery(value, today);
    if (date) {
      onSelectDay(date);
      setQuery('');
    } else setQuery(value);
  };
  const timeOf = (iso: string) => localTimeStr(new Date(iso));

  // "· 6:12 logged · in 09:48 · out 18:01": the figures in the numeral face, the words in the body face.
  const dayMeta = (date: string, list: WorkLog[]) => {
    const n = (s: string) => <span className="num">{s}</span>;
    const rec = workdays[date];
    return (
      <>
        <span>· {n(formatMinutes(list.reduce((sum, l) => sum + (l.durationMinutes ?? 0), 0)))} logged</span>
        {rec && <span>· in {n(localTimeStr(new Date(rec.clockIn)))}</span>}
        {rec?.clockOut && <span>· out {n(localTimeStr(new Date(rec.clockOut)))}</span>}
        {rec && !rec.clockOut && date < today && <span>· no clock-out</span>}
      </>
    );
  };

  const stamp = today;
  const exportItems = [
    { label: 'Download CSV', onSelect: () => download(logsToCsv(logs), `workpulse-logs-${stamp}.csv`) },
    { label: 'Copy as Markdown', onSelect: () => onCopy(logsToMarkdown(logs, projects)) },
    { label: 'Print', onSelect: () => window.print() },
  ];

  const emptyText = searching
    ? `No logs match “${query.trim()}”.`
    : logs.length === 0
      ? 'No logs yet. What you log on Today shows up here, a week at a time.'
      : 'No logs on the other days of this week.';

  return (
    <div className="v2-history mx-auto max-w-[960px] px-4 sm:px-8 py-6 sm:py-7 flex flex-col gap-7">
      <section aria-labelledby={`${id}-week`} className="no-print">
        <h2 id={`${id}-week`} className="v2-head">
          <span>Week</span>
          <span className="v2-head-meta">Pick a day to see all of it below.</span>
        </h2>
        <WeekStrip
          days={totals}
          projects={projects}
          selected={selectedDay}
          onSelectDay={(d) => d && onSelectDay(d)}
          onPrevWeek={() => moveWeek(-1)}
          onNextWeek={() => moveWeek(1)}
          label={label}
          workdays={workdays}
          hours={hours}
          nextDisabled={thisWeek}
        />
      </section>

      <section aria-labelledby={`${id}-day`} className="flex flex-col gap-4">
        <h2 id={`${id}-day`} className="v2-head">
          <span>{selectedDay === today ? `Today · ${dayLabelLong(selectedDay)}` : dayLabelLong(selectedDay)}</span>
          <span className="v2-head-meta num">{plural(summary.logs.length)}</span>
        </h2>

        <div className="no-print flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={`${id}-date`} className={LABEL}>
              Day
            </label>
            <DatePicker id={`${id}-date`} value={selectedDay} max={today} onChange={(v) => v && onSelectDay(v)} className="min-w-[11rem]" />
          </div>
          <button type="button" onClick={() => onSelectDay(today)} className="v2-btn min-h-11 px-4 cursor-pointer">
            Today
          </button>
          <button type="button" onClick={() => onSelectDay(addDays(today, -1))} className="v2-btn min-h-11 px-4 cursor-pointer">
            Yesterday
          </button>
          <div className="ml-auto">
            <RowMenu
              label="Export this day"
              buttonText="Export this day"
              items={[
                { label: 'Download CSV', onSelect: () => download(dayToCsv(summary), `workpulse-${selectedDay}.csv`) },
                { label: 'Copy as Markdown', onSelect: () => onCopy(dayToMarkdown(summary, projects, standup)) },
                {
                  label: 'Download Markdown',
                  onSelect: () => download(dayToMarkdown(summary, projects, standup), `workpulse-${selectedDay}.md`, 'text/markdown'),
                },
              ]}
            />
          </div>
        </div>

        <dl className="v2-panel v2-row v2-inset grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5 text-[length:var(--fs-small)]">
          {[
            ['Clocked in', summary.clockIn ? timeOf(summary.clockIn) : 'No clock-in'],
            ['Clocked out', summary.clockOut ? timeOf(summary.clockOut) : summary.clockIn ? (summary.noClockOut ? 'No clock-out' : 'Still in') : '--:--'],
            ['Worked', summary.workedSec === null ? '--:--' : hm(summary.workedSec)],
            ['Logged', formatMinutes(summary.loggedMinutes)],
            ['Tracked', hm(summary.trackedSec)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-[var(--text-muted)]">{k}</dt>
              <dd className="num text-[length:var(--fs-body)] font-semibold text-[var(--text-main)]">{v}</dd>
            </div>
          ))}
        </dl>

        {summary.doneTasks.length > 0 && (
          <div>
            <h3 className="pb-2 text-[length:var(--fs-small)] font-bold text-[var(--text-main)]">Done tasks</h3>
            <ul className="v2-panel">
              {summary.doneTasks.map((t) => (
                <li key={t.id} className="v2-row flex items-center gap-2 px-4 py-2 text-[length:var(--fs-body)]">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: byId.get(t.projectId)?.color ?? 'var(--text-muted)' }}
                  />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary.logs.length > 0 ? (
          <ul className="v2-panel">
            {summary.logs.map((l) => (
              <LogRow
                key={l.id}
                log={l}
                project={byId.get(l.projectId)}
                onEdit={onEditLog}
                onDuplicate={onDuplicateLog}
                onDelete={onDeleteLog}
                selected={selectedIds.includes(l.id)}
                onToggleSelect={onToggleSelect}
                onOpenImage={onOpenImage}
              />
            ))}
          </ul>
        ) : (
          <p className="v2-panel v2-row v2-inset text-[length:var(--fs-body)] text-[var(--text-muted)]">
            Nothing logged on {dayLabelLong(selectedDay)}.
          </p>
        )}

        {standup && (
          <div>
            <div className="flex items-center justify-between gap-3 pb-2">
              <h3 className="text-[length:var(--fs-small)] font-bold text-[var(--text-main)]">Standup</h3>
              <button type="button" onClick={() => onCopy(standup)} className={TEXT_BTN}>
                Copy standup
              </button>
            </div>
            <p className="v2-panel v2-row v2-inset whitespace-pre-wrap text-[length:var(--fs-body)]">{standup}</p>
          </div>
        )}
      </section>

      <section aria-labelledby={`${id}-logs`} className="flex flex-col gap-4">
        <h2 id={`${id}-logs`} className="v2-head">
          <span>Logs</span>
          <span className="v2-head-meta num">
            {plural(shown.length)}
            {searching ? ' in all weeks' : ' on the other days'}
          </span>
        </h2>

        <div className="no-print grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_auto] sm:items-end">
          <div>
            <label htmlFor={`${id}-q`} className={LABEL}>
              Search all logs
            </label>
            <input
              id={`${id}-q`}
              type="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Words, project, tag or a date"
              autoComplete="off"
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor={`${id}-p`} className={LABEL}>
              Project
            </label>
            <Select
              id={`${id}-p`}
              value={activeProject}
              onChange={setProjectId}
              options={[{ value: 'all', label: 'All projects' }, ...filterProjects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </div>
          <div className="flex justify-end gap-2">
            <SyncButton {...sync} />
            <RowMenu label="Export all logs" buttonText="Export" items={exportItems} />
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="v2-panel v2-row v2-inset flex flex-wrap items-center gap-x-4 gap-y-1">
            <p className="text-[length:var(--fs-body)] text-[var(--text-muted)]">{emptyText}</p>
            {searching && (
              <button type="button" onClick={() => setQuery('')} className={TEXT_BTN}>
                Clear search
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="no-print flex flex-wrap items-center justify-between gap-x-4 gap-y-1 -mb-1">
              <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">Tick logs for a standup or an export.</p>
              <button
                type="button"
                onClick={() => (allPicked ? onClearSelection() : onSelectMany([...new Set([...selectedIds, ...shownIds])]))}
                className={TEXT_BTN}
              >
                {allPicked ? 'Clear selection' : `Select all ${plural(shownIds.length)}`}
              </button>
            </div>
            {groups.map(([date, list]) => (
              <section key={date} aria-labelledby={`${id}-d-${date}`}>
                <h3
                  id={`${id}-d-${date}`}
                  className="flex flex-wrap items-baseline gap-x-2 pb-2 text-[length:var(--fs-small)] text-[var(--text-muted)]"
                >
                  <span className="font-bold text-[var(--text-main)]">
                    {date === today ? `Today · ${dayLabelLong(date)}` : dayLabelLong(date)}
                  </span>
                  {dayMeta(date, list)}
                </h3>
                <ul className="v2-panel">
                  {list.map((l) => (
                    <LogRow
                      key={l.id}
                      log={l}
                      project={byId.get(l.projectId)}
                      onEdit={onEditLog}
                      onDuplicate={onDuplicateLog}
                      onDelete={onDeleteLog}
                      selected={selectedIds.includes(l.id)}
                      onToggleSelect={onToggleSelect}
                      onOpenImage={onOpenImage}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </section>

      <div aria-live="polite" className="no-print sticky bottom-4 z-10 empty:hidden">
        {selectedLogs.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 bg-[var(--bg-surface-elevated)] border border-[var(--border-control)] rounded-[var(--radius-card)]">
            <p className="num text-[length:var(--fs-small)] font-semibold text-[var(--text-main)] mr-1">{plural(selectedLogs.length)} selected</p>
            <button type="button" onClick={onStandup} className="v2-btn v2-btn-strong min-h-11 px-4 cursor-pointer">
              Standup
            </button>
            <button type="button" onClick={() => onCopy(logsToMarkdown(selectedLogs, projects))} className="v2-btn min-h-11 px-4 cursor-pointer">
              Copy as Markdown
            </button>
            <button
              type="button"
              onClick={() => download(logsToCsv(selectedLogs), `workpulse-logs-${stamp}.csv`)}
              className="v2-btn min-h-11 px-4 cursor-pointer"
            >
              Download CSV
            </button>
            <button type="button" onClick={onClearSelection} className={TEXT_BTN}>
              Clear
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// Running clocks tick on their own, so a backlog that differs only in running tasks' elapsed seconds is "the same".
const sameHistoryProps = (prev: HistoryScreenProps, next: HistoryScreenProps): boolean =>
  (Object.keys(next) as (keyof HistoryScreenProps)[]).every((k) =>
    k === 'backlog' ? sameTasksIgnoringLiveTime(prev.backlog, next.backlog) : prev[k] === next[k],
  );

export const HistoryScreen = React.memo(HistoryScreenView, sameHistoryProps);
