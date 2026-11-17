import React, { useCallback, useId, useMemo, useState } from 'react';
import { DatePicker } from '../../ui/DatePicker';
import { Select } from '../../ui/Select';
import type { BacklogTask, Project, TaskStage } from '../../../types';
import { TaskRow } from '../today/TaskRow';
import { DayBlock, plural } from './EarlierGroup';
import { sameTasksIgnoringLiveTime } from '../../../utils/timerStore';
import { localDateOfIso, localTimeStr } from '../../../utils/dates';
import { defaultProject } from '../../../utils/projects';
import { dayLabelLong, filterByProject, groupTasks, sectionProjectIds } from '../../../utils/taskSections';
import { dayHeading } from '../../../utils/taskDates';

export interface TasksScreenProps {
  backlog: BacklogTask[];
  projects: Project[];
  /** Local YYYY-MM-DD. */
  today: string;
  /** `dueDate` is a local YYYY-MM-DD; absent means today. */
  onAddTask(title: string, projectId: string, stage: TaskStage, dueDate?: string): void;
  onStage(id: string, stage: TaskStage, reason?: string): void;
  onComplete(task: BacklogTask): void;
  onLogTask(task: BacklogTask): void;
  /** Reopens a done task into planned ("Back to planned"). */
  onReopen(id: string): void;
  onDeleteTask(id: string): void;
  onEditTask?(task: BacklogTask): void;
  onAdjustTime?(task: BacklogTask): void;
  /** "Write timesheet from N tasks": the ids of the selected done tasks. */
  onLogSelected(ids: string[]): void;
  /** Sets the due date of the given pending tasks to today ("Move to today", "Move all to today"). */
  onMoveToToday(ids: string[]): void;
}

const LABEL = 'block mb-1 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]';
const FIELD = 'v2-input w-full h-11 px-3 text-[length:var(--fs-body)]';
const TEXT_BTN =
  'min-h-8 pointer-coarse:min-h-11 px-1 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] underline underline-offset-4 cursor-pointer';

/** A section: the same heading as Today, a panel under it. */
const Section: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({ title, count, children }) => {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="v2-head">
        <span>{title}</span>
        <span className="v2-head-meta num">{plural(count)}</span>
      </h2>
      <div className="v2-panel">{children}</div>
    </section>
  );
};

const TasksScreenView: React.FC<TasksScreenProps> = ({
  backlog,
  projects,
  today,
  onAddTask,
  onStage,
  onComplete,
  onLogTask,
  onReopen,
  onDeleteTask,
  onEditTask,
  onAdjustTime,
  onLogSelected,
  onMoveToToday,
}) => {
  const id = useId();
  const [title, setTitle] = useState('');
  const [projectDraft, setProjectDraft] = useState('');
  const [dueDraft, setDueDraft] = useState('');
  const [filter, setFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const all = useMemo(() => groupTasks(backlog, today), [backlog, today]);
  const projectIds = useMemo(() => sectionProjectIds(all), [all]);
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const activeFilter = filter && projectIds.includes(filter) ? filter : null;
  const sections = useMemo(() => filterByProject(all, activeFilter), [all, activeFilter]);
  const chips = projects.filter((p) => projectIds.includes(p.id));

  // The add row: a draft that is gone, archived or empty falls back to the first active project / today.
  const active = projects.filter((p) => !p.isArchived);
  const projectId = active.some((p) => p.id === projectDraft) ? projectDraft : (defaultProject(projects)?.id ?? 'default');
  const due = dueDraft && dueDraft >= today ? dueDraft : today;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = title.trim();
    if (!text) return;
    onAddTask(text, projectId, 'planned', due);
    setTitle('');
    setDueDraft('');
  };

  // Selection only counts done tasks that are on screen (a project filter hides the rest).
  const doneIds = sections.doneRecently.map((t) => t.id);
  const picked = doneIds.filter((i) => selected.includes(i));
  const allPicked = doneIds.length > 0 && picked.length === doneIds.length;
  const toggle = useCallback(
    (taskId: string) => setSelected((cur) => (cur.includes(taskId) ? cur.filter((i) => i !== taskId) : [...cur, taskId])),
    [],
  );

  const row = (t: BacklogTask, extra: Partial<React.ComponentProps<typeof TaskRow>> = {}) => (
    <TaskRow
      key={t.id}
      task={t}
      project={byId.get(t.projectId)}
      onStage={onStage}
      onComplete={onComplete}
      onLogTask={onLogTask}
      onReopen={onReopen}
      onDeleteTask={onDeleteTask}
      onEditTask={onEditTask}
      onAdjustTime={onAdjustTime}
      {...extra}
    />
  );

  const anyTasks = projectIds.length > 0;
  const upcomingCount = sections.upcoming.reduce((n, d) => n + d.tasks.length, 0);
  const plans = sections.plans;
  const sumGroups = (groups: { tasks: BacklogTask[] }[]) => groups.reduce((n, d) => n + d.tasks.length, 0);
  const plansCount = plans.today.length + sumGroups(plans.earlier) + sumGroups(plans.upcoming);
  const moveOne = useCallback((taskId: string) => onMoveToToday([taskId]), [onMoveToToday]);

  return (
    <div className="mx-auto max-w-[1440px] px-4 sm:px-8 py-6 sm:py-7 flex flex-col gap-7">
      <form onSubmit={submit} aria-label="Add a task" className="v2-panel v2-inset py-[var(--row-pad)]">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(11rem,15rem)_10rem_auto] sm:items-end">
          <div>
            <label htmlFor={`${id}-title`} className={LABEL}>
              Task
            </label>
            <input
              id={`${id}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              autoComplete="off"
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor={`${id}-project`} className={LABEL}>
              Project
            </label>
            <Select
              id={`${id}-project`}
              value={projectId}
              onChange={setProjectDraft}
              options={active.length === 0 ? [{ value: 'default', label: 'General' }] : active.map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
          <div>
            <label htmlFor={`${id}-due`} className={LABEL}>
              Due
            </label>
            <DatePicker id={`${id}-due`} value={due} min={today} onChange={(v) => v && setDueDraft(v)} />
          </div>
          <button
            type="submit"
            disabled={!title.trim()}
            className="v2-btn v2-btn-strong h-11 px-5 cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            Add
          </button>
        </div>
      </form>

      {chips.length > 1 && (
        <div role="group" aria-label="Filter by project" className="flex flex-wrap gap-2 -mt-2">
          {[null, ...chips].map((p) => {
            const on = (p?.id ?? null) === activeFilter;
            return (
              <button
                key={p?.id ?? 'all'}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(p?.id ?? null)}
                className={`v2-btn ${on ? 'v2-btn-strong' : ''} inline-flex items-center gap-2 min-h-8 pointer-coarse:min-h-11 px-3 cursor-pointer transition-colors`}
              >
                {p && <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />}
                {p ? p.name : 'All'}
              </button>
            );
          })}
        </div>
      )}

      {/* Phones: one column, Plans first. Desktop: started work on the left, Plans on the right. */}
      <div className="grid gap-7 lg:grid-cols-2 lg:items-start">
        <div className="order-2 lg:order-1 flex flex-col gap-7 min-w-0">
          <Section title="Today" count={sections.today.length}>
            {sections.today.length === 0 ? (
              <p className="v2-row v2-inset text-[length:var(--fs-body)] text-[var(--text-muted)]">
                {anyTasks ? 'Nothing running or paused today.' : 'Nothing started yet. Start a plan from the list.'}
              </p>
            ) : (
              <ul>{sections.today.map((t) => row(t, { fromLabel: t.dueDate < today ? dayHeading(t.dueDate, today) : undefined, onMoveToToday: moveOne }))}</ul>
            )}
          </Section>

          {sections.earlier.map((d) => (
            <Section key={d.date} title={dayHeading(d.date, today)} count={d.tasks.length}>
              <ul>{d.tasks.map((t) => row(t, { onMoveToToday: moveOne }))}</ul>
            </Section>
          ))}

          {upcomingCount > 0 && (
            <Section title="Upcoming" count={upcomingCount}>
              {sections.upcoming.map((d) => (
                <React.Fragment key={d.date}>
                  <h3 className="v2-inset pt-3 pb-1 text-[length:var(--fs-small)] font-bold text-[var(--text-muted)] border-t border-[var(--border-app)] first:border-t-0">
                    {dayHeading(d.date, today)}
                  </h3>
                  <ul>{d.tasks.map((t) => row(t, { onMoveToToday: moveOne }))}</ul>
                </React.Fragment>
              ))}
            </Section>
          )}

        {sections.doneRecently.length > 0 && (
          <Section title="Done recently" count={sections.doneRecently.length}>
            <div className="v2-row v2-inset flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">Tick done tasks to write a timesheet from them.</p>
              <button
                type="button"
                onClick={() => setSelected(allPicked ? selected.filter((i) => !doneIds.includes(i)) : [...new Set([...selected, ...doneIds])])}
                className={TEXT_BTN}
              >
                {allPicked ? 'Clear selection' : 'Select all'}
              </button>
            </div>
            <ul>
              {sections.doneRecently.map((t) =>
                row(t, {
                  selected: picked.includes(t.id),
                  onToggleSelect: toggle,
                  meta: t.completedAt
                    ? `done ${dayLabelLong(localDateOfIso(t.completedAt))}, ${localTimeStr(new Date(t.completedAt))}`
                    : `done ${dayLabelLong(t.dueDate)}`,
                }),
              )}
            </ul>
          </Section>
        )}
        </div>

        <div className="order-1 lg:order-2 min-w-0">
          <Section title="Plans" count={plansCount}>
            {plansCount === 0 && (
              <p className="v2-row v2-inset text-[length:var(--fs-body)] text-[var(--text-muted)]">
                {anyTasks ? 'No plans waiting.' : 'Nothing planned yet. Add the first task above.'}
              </p>
            )}
            {plans.today.length > 0 && (
              <DayBlock heading={dayHeading(today, today)} tasks={plans.today}>
                <ul>{plans.today.map((t) => row(t))}</ul>
              </DayBlock>
            )}
            {plans.earlier.map((d) => (
              <DayBlock key={d.date} heading={dayHeading(d.date, today)} tasks={d.tasks} onMoveAll={onMoveToToday}>
                <ul>{d.tasks.map((t) => row(t, { onMoveToToday: moveOne }))}</ul>
              </DayBlock>
            ))}
            {plans.upcoming.map((d) => (
              <DayBlock key={d.date} heading={dayHeading(d.date, today)} tasks={d.tasks}>
                <ul>{d.tasks.map((t) => row(t, { onMoveToToday: moveOne }))}</ul>
              </DayBlock>
            ))}
          </Section>
        </div>
      </div>

      <div aria-live="polite" className="sticky bottom-4 z-10 empty:hidden">
        {picked.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 bg-[var(--bg-surface-elevated)] border border-[var(--border-control)] rounded-[var(--radius-card)]">
            <button
              type="button"
              onClick={() => {
                onLogSelected(picked);
                setSelected([]);
              }}
              className="v2-btn v2-btn-strong min-h-11 px-4 cursor-pointer"
            >
              Write timesheet from {plural(picked.length)}
            </button>
            <button type="button" onClick={() => setSelected([])} className={TEXT_BTN}>
              Clear
            </button>
            <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">Time already in a log is not added twice.</p>
          </div>
        )}
      </div>
    </div>
  );
};

// Redraws only when something it shows changes: running clocks tick on their own (<TaskClock>),
// so a backlog that differs only in running tasks' elapsed seconds is "the same".
const sameTasksProps = (prev: TasksScreenProps, next: TasksScreenProps): boolean =>
  (Object.keys(next) as (keyof TasksScreenProps)[]).every((k) =>
    k === 'backlog' ? sameTasksIgnoringLiveTime(prev.backlog, next.backlog) : prev[k] === next[k],
  );

export const TasksScreen = React.memo(TasksScreenView, sameTasksProps);
