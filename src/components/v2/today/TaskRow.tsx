import { adjustedLabel } from '../../../utils/adjustTime';
import React, { useId, useState } from 'react';
import { Check } from 'lucide-react';
import type { BacklogTask, Project, TaskStage } from '../../../types';
import { TaskClock } from '../../tasks/Clock';
import { StatePill, rowState } from './StateMark';
import { getTaskStage } from '../../tasks/helpers';
import { RowMenu, RowMenuItem } from '../RowMenu';
import { SampleBadge } from '../../ui/SampleBadge';
import { isSampleTask } from '../../../data/sampleData';
import { isRunningTask } from '../../../utils/timerStore';
import { loggedSecondsOf, unloggedSeconds } from '../../../utils/taskLogging';
import { localDateStr, localTimeStr } from '../../../utils/dates';

export interface TaskRowProps {
  task: BacklogTask;
  /** The task's project (ribbon colour and name). Absent: the project was deleted. */
  project?: Project;
  /** Start, pause, resume, block (with a reason) and back to planned. */
  onStage(id: string, stage: TaskStage, reason?: string): void;
  /** Done: moves the task to done without writing a log. */
  onComplete(task: BacklogTask): void;
  /** "Log it": writes the done task's unlogged time into a log. */
  onLogTask(task: BacklogTask): void;
  /** "Back to planned" on a done task. */
  onReopen(id: string): void;
  onDeleteTask(id: string): void;
  /** Opens the edit dialog (title, project, date). "Edit" shows only when given. */
  onEditTask?(task: BacklogTask): void;
  /** Opens "Adjust time" (a timer started late, or a total to correct). Shown when given. */
  onAdjustTime?(task: BacklogTask): void;
  /** Replaces the meta line after the project name (e.g. a due date on the Tasks screen). */
  meta?: React.ReactNode;
  /** A muted "from Yesterday" after the meta, for a running/paused/blocked task dated before today. */
  fromLabel?: string;
  /** A muted "due Mon 9 Nov" after the meta, in groups that span several dates (Plan screen). */
  dueLabel?: string;
  /** Shows a selection checkbox when given. */
  selected?: boolean;
  onToggleSelect?(id: string): void;
  /** Adds "Move to today" to the menu (not for done tasks or tasks already due today). */
  onMoveToToday?(id: string): void;
  /** Added after the standard menu items (Done, Block, Back to planned), before Delete. */
  extraMenuItems?: RowMenuItem[];
}

const hm = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const timeOf = (iso?: string) => (iso ? localTimeStr(new Date(iso)) : '');

/** The meta after the state pill (the pill already says the stage): started 14:02, 1:10 tracked, at 16:13. */
export function metaFor(task: BacklogTask, stage: TaskStage): string {
  const tracked = task.elapsedSeconds || 0;
  const adjusted = adjustedLabel(task) ? ` · ${adjustedLabel(task)}` : '';
  switch (stage) {
    case 'in_progress':
      if (isRunningTask(task)) return `${task.startedAt ? `started ${timeOf(task.startedAt)}` : ''}${adjusted}`.replace(/^ · /, '');
      return tracked > 0 ? `${hm(tracked)} tracked${adjusted}` : 'not started';
    case 'done':
      return task.completedAt ? `at ${timeOf(task.completedAt)}` : '';
    case 'blocked':
      return '';
    default:
      return tracked > 0 ? `${hm(tracked)} tracked` : '';
  }
}

/** One task: ribbon, title, meta, live clock, one primary button by stage, and a ⋯ menu. */
export const TaskRow: React.FC<TaskRowProps> = ({
  task,
  project,
  onStage,
  onComplete,
  onLogTask,
  onReopen,
  onDeleteTask,
  onEditTask,
  onAdjustTime,
  meta,
  fromLabel,
  dueLabel,
  selected,
  onToggleSelect,
  onMoveToToday,
  extraMenuItems = [],
}) => {
  const id = useId();
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState('');

  const stage = getTaskStage(task);
  const done = stage === 'done';
  const running = isRunningTask(task);
  const hasTime = (task.elapsedSeconds || 0) > 0 || running;
  // A done task is logged once a log holds all its time (or it was logged with none).
  const logged = done && unloggedSeconds(task) === 0 && (loggedSecondsOf(task) > 0 || !!task.isSynthesized);

  let primary: { label: string; onClick(): void } | null;
  if (running) primary = { label: 'Pause', onClick: () => onStage(task.id, 'paused') };
  else if (stage === 'paused' || stage === 'blocked' || stage === 'in_progress')
    primary = { label: 'Resume', onClick: () => onStage(task.id, 'in_progress') };
  else if (stage === 'planned') primary = { label: 'Start', onClick: () => onStage(task.id, 'in_progress') };
  else primary = logged ? null : { label: 'Log it', onClick: () => onLogTask(task) };

  const items: RowMenuItem[] = [];
  if (onEditTask) items.push({ label: 'Edit', onSelect: () => onEditTask(task) });
  if (onAdjustTime && stage !== 'planned') items.push({ label: 'Adjust time', onSelect: () => onAdjustTime(task) });
  if (!done && stage !== 'blocked') items.push({ label: 'Block', onSelect: () => setBlocking(true) });
  if (stage !== 'planned')
    items.push({ label: 'Back to planned', onSelect: () => (done ? onReopen(task.id) : onStage(task.id, 'planned')) });
  if (onMoveToToday && !done && task.dueDate !== localDateStr())
    items.push({ label: 'Move to today', onSelect: () => onMoveToToday(task.id) });
  items.push(...extraMenuItems);
  items.push({ label: 'Delete', danger: true, onSelect: () => onDeleteTask(task.id) });

  // Everything after the pill, one " · " between parts; empty parts drop out.
  const rest = [
    meta ?? metaFor(task, stage),
    fromLabel ? `from ${fromLabel}` : '',
    dueLabel ? `due ${dueLabel}` : '',
    task.fromPhone ? 'from phone' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const saveBlock = () => {
    onStage(task.id, 'blocked', reason.trim() || undefined);
    setBlocking(false);
    setReason('');
  };

  return (
    <li className={`v2-row v2-inset ${running ? 'v2-running' : ''}`}>
      <div className="flex items-center gap-3.5">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect(task.id)}
            aria-label={`Select: ${task.title}`}
            className="w-4 h-4 shrink-0 accent-[var(--accent-text)]"
          />
        )}
        <span
          className="v2-ribbon self-stretch min-h-8"
          style={{ backgroundColor: project?.color ?? 'var(--border-control)' }}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <div className="flex-1 min-w-48">
            <p
              className={`text-[length:var(--fs-body)] font-semibold break-words ${done ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-main)]'}`}
            >
              {task.title}
            </p>
            {stage === 'blocked' && task.blockReason && (
              <p className="mt-0.5 text-[length:var(--fs-small)] text-[var(--text-main)] break-words">Blocked: {task.blockReason}</p>
            )}
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-small)] text-[var(--text-muted)]">
              <span className="break-words">{project?.name ?? 'No project'}</span>
              <StatePill state={rowState(stage, running)} />
              {rest && <span className="break-words">· {rest}</span>}
              <SampleBadge show={isSampleTask(task)} />
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 ml-auto">
            <span
              className={`num shrink-0 text-[length:var(--fs-body)] font-bold ${running ? 'text-[var(--accent-text)]' : 'text-[var(--text-muted)]'}`}
            >
              {hasTime ? (
                <TaskClock task={task} />
              ) : (
                <>
                  <span aria-hidden="true">--:--</span>
                  <span className="sr-only">No time tracked</span>
                </>
              )}
            </span>
            <div className="shrink-0 w-24">
              {primary ? (
                <button
                  type="button"
                  onClick={primary.onClick}
                  className={`v2-btn ${running ? 'v2-btn-strong' : ''} w-full min-h-8 pointer-coarse:min-h-11 px-3 cursor-pointer transition-colors`}
                >
                  {primary.label}
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  className="v2-btn w-full min-h-8 pointer-coarse:min-h-11 px-3 inline-flex items-center justify-center gap-1 opacity-70 cursor-default"
                >
                  Logged
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
            {!done && (
              <button
                type="button"
                onClick={() => onComplete(task)}
                aria-label={`Mark done: ${task.title}`}
                className="v2-btn shrink-0 min-h-8 pointer-coarse:min-h-11 px-3 inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
              >
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                Done
              </button>
            )}
            <RowMenu label={`Actions for ${task.title}`} items={items} />
          </div>
        </div>
      </div>

      {blocking && (
        <form
          className="mt-2.5 flex flex-wrap items-center gap-2 pl-5"
          onSubmit={(e) => {
            e.preventDefault();
            saveBlock();
          }}
        >
          <label htmlFor={`${id}-reason`} className="text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]">
            What is it waiting on?
          </label>
          <input
            id={`${id}-reason`}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setBlocking(false);
              }
            }}
            placeholder="e.g. API key from the vendor"
            className="v2-input flex-1 min-w-40 h-9 px-3 text-[length:var(--fs-small)]"
          />
          <button type="submit" className="v2-btn v2-btn-strong min-h-9 px-3 cursor-pointer">
            Block
          </button>
          <button type="button" onClick={() => setBlocking(false)} className="v2-btn min-h-9 px-3 cursor-pointer">
            Cancel
          </button>
        </form>
      )}
    </li>
  );
};
