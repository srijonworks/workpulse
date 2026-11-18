import React, { useEffect, useId, useMemo, useState } from 'react';
import { DatePicker } from '../../ui/DatePicker';
import { Select } from '../../ui/Select';
import type { BacklogTask, Project, WorkLog, Workdays } from '../../../types';
import { addDays, localDateStr, localTimeStr } from '../../../utils/dates';
import { weekDays, weekTotals } from '../../../utils/weekTotals';
import { dayLabelLong } from '../../../utils/taskSections';
import { logsToCsv, logsToMarkdown } from '../../../utils/exportLogs';
import { hm, parseDateQuery, rangeToMarkdown, summarizeRange, type DaySummary } from '../../../utils/historyDay';
import { sameTasksIgnoringLiveTime } from '../../../utils/timerStore';
import { useNow } from '../useNow';
import { LogRow, formatMinutes } from '../today/LogRow';
import { RowMenu } from '../RowMenu';
import { RichText } from '../../ui/RichText';
import { WeekStrip } from './WeekStrip';
import { SyncButton, type SyncState } from '../SyncButton';

export interface HistoryScreenProps {
  logs: WorkLog[];
  projects: Project[];
  workdays: Workdays;
  /** Tasks: each day lists the tasks finished that day and its tracked time. */
  backlog: BacklogTask[];
  /** First day of the range (a local date). App keeps it, with `rangeEnd`, so it survives tab switches. */
  selectedDay: string;
  /** Last day of the range; the same as `selectedDay` for one day. */
  rangeEnd: string;
  /** Shows exactly one day. */
  onSelectDay(date: string): void;
  /** Shows the days from `from` to `to`, both included. */
  onSelectRange(from: string, to: string): void;
  /** The saved standup text of a date, when there is one (shown under its day with Copy). */
  standupFor?(date: string): string | undefined;
  /** True when the standup of this date was written with the plain template and can be written again with the AI. */
  canRewriteStandup?(date: string): boolean;
  /** Writes it again with the AI. Resolves true when an AI wrote it, false when the AI is still not available. */
  onRewriteStandup?(date: string): Promise<boolean>;
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
  /** A log to show (picked in the search palette): the page jumps to its day and the row is scrolled to. */
  focusDate?: string;
  focusLogId?: string;
  /** Called once the focus request was taken, so App can clear it. */
  onFocusHandled?(): void;
}

const LABEL = 'block mb-1 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]';
const FIELD = 'v2-input w-full h-11 px-3 text-[length:var(--fs-body)]';
const BTN = 'v2-btn min-h-11 px-4 cursor-pointer';
const TEXT_BTN =
  'min-h-8 pointer-coarse:min-h-11 px-1 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] underline underline-offset-4 cursor-pointer';

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ALL_FROM = '0000-01-01';

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
  rangeEnd,
  onSelectDay,
  onSelectRange,
  standupFor,
  canRewriteStandup,
  onRewriteStandup,
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
  const [allDates, setAllDates] = useState(false);

  const from = selectedDay;
  const to = rangeEnd >= from ? rangeEnd : from;
  const single = from === to;

  // A log picked in the search palette: show its day with no search or project filter, then scroll to it.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!focusDate || !focusLogId) return;
    setAnchor(focusDate);
    onSelectDay(focusDate);
    setQuery('');
    setProjectId('all');
    setAllDates(false);
    setScrollTo(focusLogId);
    onFocusHandled?.();
  }, [focusDate, focusLogId, onFocusHandled, onSelectDay]);

  // The week strip follows the first day.
  useEffect(() => setAnchor(selectedDay), [selectedDay]);

  const weekOf = useMemo(() => weekDays(anchor), [anchor]);
  const totals = useMemo(() => weekTotals(logs, weekOf), [logs, weekOf]);
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const thisWeek = weekOf.includes(today);
  const lastWeek = !thisWeek && weekOf.includes(addDays(today, -7));
  const weekText = weekRange(weekOf);
  const weekLabel = thisWeek ? `This week · ${weekText}` : lastWeek ? `Last week · ${weekText}` : weekText;
  const moveWeek = (n: number) => setAnchor((a) => addDays(a, n * 7));

  // Projects that have logs, so the filter offers only what can match.
  const usedIds = useMemo(() => new Set(logs.map((l) => l.projectId)), [logs]);
  const filterProjects = projects.filter((p) => usedIds.has(p.id));
  const activeProject = projectId !== 'all' && usedIds.has(projectId) ? projectId : 'all';

  const searching = query.trim() !== '';
  // "All dates" only matters while something is searched or filtered; otherwise the chosen dates rule.
  const everywhere = allDates && (searching || activeProject !== 'all');

  const result = useMemo(
    () =>
      summarizeRange({
        from: everywhere ? ALL_FROM : from,
        to: everywhere ? today : to,
        today,
        nowMs: now,
        logs,
        workdays,
        backlog,
        query,
        projectId: activeProject,
      }),
    [everywhere, from, to, today, now, logs, workdays, backlog, query, activeProject],
  );

  const shownLogs = useMemo(() => result.days.flatMap((d) => d.logs), [result]);
  const shownIds = shownLogs.map((l) => l.id);
  const allPicked = shownIds.length > 0 && shownIds.every((i) => selectedIds.includes(i));
  const selectedLogs = useMemo(() => logs.filter((l) => selectedIds.includes(l.id)), [logs, selectedIds]);

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
  }, [scrollTo, result]);

  // A search that is a date ("2026-11-14", "yesterday", "today") jumps to that day instead.
  const onQuery = (value: string) => {
    const date = parseDateQuery(value, today);
    if (date) {
      onSelectDay(date);
      setQuery('');
    } else setQuery(value);
  };

  const [rewriting, setRewriting] = useState('');
  const [rewriteNote, setRewriteNote] = useState<{ date: string; text: string } | null>(null);
  const timeOf = (iso: string) => localTimeStr(new Date(iso));

  // "in 09:48 · out 18:01 · worked 8:13 · logged 6:12 · tracked 5:40": the figures in the numeral face, the words in the body face.
  const dayMeta = (d: DaySummary) => {
    const n = (s: string) => <span className="num">{s}</span>;
    return (
      <>
        {d.clockIn && <span>· in {n(timeOf(d.clockIn))}</span>}
        {d.clockOut && <span>· out {n(timeOf(d.clockOut))}</span>}
        {d.clockIn && !d.clockOut && <span>{d.noClockOut ? '· no clock-out' : '· still in'}</span>}
        {d.workedSec !== null && <span>· worked {n(hm(d.workedSec))}</span>}
        {d.loggedMinutes > 0 && <span>· logged {n(formatMinutes(d.loggedMinutes))}</span>}
        {d.trackedSec > 0 && <span>· tracked {n(hm(d.trackedSec))}</span>}
      </>
    );
  };

  const dateText = everywhere
    ? 'All dates'
    : single
      ? from === today
        ? `Today · ${dayLabelLong(from)}`
        : dayLabelLong(from)
      : `${dayLabelLong(from)} – ${dayLabelLong(to)}`;
  const stamp = everywhere ? 'all-dates' : single ? from : `${from}_to_${to}`;
  const exportItems = [
    { label: 'Download CSV', onSelect: () => download(logsToCsv(shownLogs), `workpulse-logs-${stamp}.csv`) },
    { label: 'Copy as Markdown', onSelect: () => onCopy(rangeToMarkdown(result.days, projects, from, to, standupFor)) },
    {
      label: 'Download Markdown',
      onSelect: () => download(rangeToMarkdown(result.days, projects, from, to, standupFor), `workpulse-${stamp}.md`, 'text/markdown'),
    },
    { label: 'Print', onSelect: () => window.print() },
  ];

  const emptyText = searching
    ? `No logs or tasks match “${query.trim()}”${everywhere ? '' : ' in these dates'}.`
    : activeProject !== 'all'
      ? 'Nothing for this project in these dates.'
      : logs.length === 0 && backlog.length === 0
        ? 'No logs yet. What you log on Today shows up here.'
        : single
          ? `Nothing recorded on ${dayLabelLong(from)}.`
          : `Nothing recorded from ${dayLabelLong(from)} to ${dayLabelLong(to)}.`;

  return (
    <div className="v2-history mx-auto max-w-[960px] px-4 sm:px-8 py-6 sm:py-7 flex flex-col gap-6">
      <section aria-label="Choose what to show" className="no-print flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={`${id}-from`} className={LABEL}>
              From
            </label>
            <DatePicker
              id={`${id}-from`}
              value={from}
              max={today}
              onChange={(v) => v && onSelectRange(v, v > to ? v : to)}
              className="min-w-[11rem]"
            />
          </div>
          <div>
            <label htmlFor={`${id}-to`} className={LABEL}>
              To
            </label>
            <DatePicker
              id={`${id}-to`}
              value={to}
              max={today}
              onChange={(v) => v && onSelectRange(v < from ? v : from, v)}
              className="min-w-[11rem]"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onSelectDay(today)} className={BTN}>
              Today
            </button>
            <button type="button" onClick={() => onSelectDay(addDays(today, -1))} className={BTN}>
              Yesterday
            </button>
            <button type="button" onClick={() => onSelectRange(addDays(today, -6), today)} className={BTN}>
              Last 7 days
            </button>
            <button type="button" onClick={() => onSelectRange(addDays(today, -29), today)} className={BTN}>
              Last 30 days
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_auto] sm:items-end">
          <div>
            <label htmlFor={`${id}-q`} className={LABEL}>
              Search
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
            <RowMenu
              label="Export logs"
              buttonText={`Export ${plural(result.logCount, 'log')}, ${plural(result.taskCount, 'task')}`}
              items={exportItems}
            />
          </div>
        </div>
        <label className="flex min-h-8 w-fit items-center gap-2 text-[length:var(--fs-small)] text-[var(--text-muted)] cursor-pointer">
          <input type="checkbox" checked={allDates} onChange={(e) => setAllDates(e.target.checked)} className="h-4 w-4" />
          Search and project filter look at all dates, not only the chosen ones
        </label>
      </section>

      <section aria-labelledby={`${id}-week`} className="no-print">
        <h2 id={`${id}-week`} className="v2-head">
          <span>Week</span>
          <span className="v2-head-meta">Pick a day to show only that day.</span>
        </h2>
        <WeekStrip
          days={totals}
          projects={projects}
          selected={single ? from : ''}
          onSelectDay={(d) => d && onSelectDay(d)}
          onPrevWeek={() => moveWeek(-1)}
          onNextWeek={() => moveWeek(1)}
          label={weekLabel}
          workdays={workdays}
          hours={hours}
          nextDisabled={thisWeek}
        />
      </section>

      <div className="flex flex-col gap-2">
        <h2 className="v2-head">
          <span>{dateText}</span>
          <span className="v2-head-meta num">
            {plural(result.logCount, 'log')} · {plural(result.taskCount, 'task')} done · {formatMinutes(result.loggedMinutes)} logged
            {result.days.length > 1 ? ` · ${plural(result.days.length, 'day')}` : ''}
          </span>
        </h2>
      </div>

      {result.days.length === 0 ? (
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
          {shownIds.length > 0 && (
            <div className="no-print flex flex-wrap items-center justify-between gap-x-4 gap-y-1 -mb-3">
              <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">Tick logs for a standup or an export.</p>
              <button
                type="button"
                onClick={() => (allPicked ? onClearSelection() : onSelectMany([...new Set([...selectedIds, ...shownIds])]))}
                className={TEXT_BTN}
              >
                {allPicked ? 'Clear selection' : `Select all ${plural(shownIds.length, 'log')}`}
              </button>
            </div>
          )}
          {result.days.map((d) => {
            const standup = standupFor?.(d.date);
            return (
              <section key={d.date} aria-labelledby={`${id}-d-${d.date}`} className="flex flex-col gap-3">
                <h3
                  id={`${id}-d-${d.date}`}
                  className="flex flex-wrap items-baseline gap-x-2 text-[length:var(--fs-small)] text-[var(--text-muted)]"
                >
                  <span className="font-bold text-[var(--text-main)]">
                    {d.date === today ? `Today · ${dayLabelLong(d.date)}` : dayLabelLong(d.date)}
                  </span>
                  {dayMeta(d)}
                </h3>

                {d.doneTasks.length > 0 && (
                  <div>
                    <h4 className="pb-2 text-[length:var(--fs-small)] font-bold text-[var(--text-main)]">Done tasks</h4>
                    <ul className="v2-panel">
                      {d.doneTasks.map((t) => (
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

                {d.logs.length > 0 ? (
                  <ul className="v2-panel">
                    {d.logs.map((l) => (
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
                  d.doneTasks.length === 0 && (
                    <p className="v2-panel v2-row v2-inset text-[length:var(--fs-body)] text-[var(--text-muted)]">
                      Nothing logged on {dayLabelLong(d.date)}.
                    </p>
                  )
                )}

                {standup && (
                  <div>
                    <div className="flex items-center justify-between gap-3 pb-2">
                      <h4 className="text-[length:var(--fs-small)] font-bold text-[var(--text-main)]">Standup</h4>
                      <div className="no-print flex items-center gap-3">
                        {onRewriteStandup && canRewriteStandup?.(d.date) && (
                          <button
                            type="button"
                            disabled={rewriting === d.date}
                            onClick={async () => {
                              setRewriting(d.date);
                              setRewriteNote(null);
                              const ok = await onRewriteStandup(d.date);
                              setRewriting('');
                              if (!ok) setRewriteNote({ date: d.date, text: 'The AI writer is still not available. Try again later.' });
                            }}
                            className={TEXT_BTN}
                          >
                            {rewriting === d.date ? 'Writing…' : 'Rewrite with AI'}
                          </button>
                        )}
                        <button type="button" onClick={() => onCopy(standup)} className={TEXT_BTN}>
                          Copy standup
                        </button>
                      </div>
                    </div>
                    {rewriteNote?.date === d.date && (
                      <p role="status" className="pb-2 text-[length:var(--fs-small)] text-[var(--text-muted)]">
                        {rewriteNote.text}
                      </p>
                    )}
                    <RichText text={standup} className="v2-panel v2-row v2-inset text-[length:var(--fs-body)]" />
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}

      <div aria-live="polite" className="no-print sticky bottom-4 z-10 empty:hidden">
        {selectedLogs.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 bg-[var(--bg-surface-elevated)] border border-[var(--border-control)] rounded-[var(--radius-card)]">
            <p className="num text-[length:var(--fs-small)] font-semibold text-[var(--text-main)] mr-1">{plural(selectedLogs.length, 'log')} selected</p>
            <button type="button" onClick={onStandup} className="v2-btn v2-btn-strong min-h-11 px-4 cursor-pointer">
              Standup
            </button>
            <button
              type="button"
              onClick={() => onCopy(logsToMarkdown(selectedLogs, projects))}
              className="v2-btn min-h-11 px-4 cursor-pointer"
            >
              Copy as Markdown
            </button>
            <button
              type="button"
              onClick={() => download(logsToCsv(selectedLogs), `workpulse-logs-${today}.csv`)}
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
