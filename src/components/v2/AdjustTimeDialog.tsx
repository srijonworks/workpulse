import React, { useId, useState } from 'react';
import { ModalShell } from '../ui/ModalShell';
import type { BacklogTask } from '../../types';
import { localTimeStr } from '../../utils/dates';
import { backdateRunning, setTrackedTotal, timeOnDateOf } from '../../utils/adjustTime';

interface Props {
  task: BacklogTask;
  onClose(): void;
  /** The task with its time adjusted; App saves it. */
  onSave(updated: BacklogTask, message: string): void;
}

const FIELD =
  'h-10 px-3 rounded-[var(--radius-btn)] border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--text-main)] text-[length:var(--fs-body)] focus:border-[var(--border-focus)]';
const LABEL = 'block mb-1.5 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]';
const HINT = 'mt-1.5 text-[length:var(--fs-small)] text-[var(--text-muted)]';

const hm = (sec: number): string => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/**
 * Fix a task's time. A running timer that should have started earlier gets its real start time (the difference is added);
 * any other task gets its total set. Nothing here invents time: the start can only move back, and a total cannot go below
 * what is already written into a log.
 */
export const AdjustTimeDialog: React.FC<Props> = ({ task, onClose, onSave }) => {
  const id = useId();
  const open = task.segments && task.segments.length > 0 && task.segments[task.segments.length - 1].end === undefined && task.stage === 'in_progress';
  const runStart = open ? (task.segments as { start: string }[])[task.segments!.length - 1].start : '';
  const [start, setStart] = useState(open ? localTimeStr(new Date(runStart)) : '');
  const total = task.elapsedSeconds ?? 0;
  const [hours, setHours] = useState(String(Math.floor(total / 3600)));
  const [minutes, setMinutes] = useState(String(Math.floor((total % 3600) / 60)));
  const [error, setError] = useState('');

  // What the change would add, shown before saving.
  const startIso = open ? timeOnDateOf(start, runStart) : null;
  const preview = open && startIso ? Math.round((Date.parse(runStart) - Date.parse(startIso)) / 1000) : 0;

  const save = () => {
    if (open) {
      const iso = timeOnDateOf(start, runStart);
      if (!iso) return setError('Enter the time you really started, for example 09:50.');
      const r = backdateRunning(task, iso);
      if (!r.ok) return setError(r.message);
      return onSave(r.task, `Timer moved back to ${start}: ${hm(r.info.addedSeconds)} added.`);
    }
    const secs = Number(hours || 0) * 3600 + Number(minutes || 0) * 60;
    const r = setTrackedTotal(task, secs);
    if (!r.ok) return setError(r.message);
    onSave(r.task, `Time set to ${hm(secs)}.`);
  };

  return (
    <ModalShell
      onClose={onClose}
      labelledBy={`${id}-t`}
      closeOnBackdrop
      className="w-full max-w-md p-6 bg-[var(--bg-surface-elevated)] text-[var(--text-main)] border border-[var(--border-app)] rounded-[var(--radius-card)]"
    >
      <h2 id={`${id}-t`} className="text-[length:var(--fs-body)] font-bold">
        Adjust time
      </h2>
      <p className="mt-1 text-[length:var(--fs-small)] text-[var(--text-muted)] break-words">{task.title}</p>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {open ? (
          <div>
            <label htmlFor={`${id}-start`} className={LABEL}>
              I really started at
            </label>
            <input
              id={`${id}-start`}
              data-autofocus
              type="time"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                setError('');
              }}
              className={`${FIELD} num`}
            />
            <p className={HINT}>
              The timer started at <span className="num">{localTimeStr(new Date(runStart))}</span>. A earlier time adds the difference
              {preview > 0 ? <strong className="text-[var(--text-main)]">: {hm(preview)} will be added</strong> : ''}.
            </p>
          </div>
        ) : (
          <div>
            <span className={LABEL}>Tracked time</span>
            <div className="flex items-center gap-2">
              <input
                aria-label="Hours"
                data-autofocus
                type="number"
                min={0}
                max={24}
                value={hours}
                onChange={(e) => {
                  setHours(e.target.value);
                  setError('');
                }}
                className={`${FIELD} num w-20`}
              />
              <span className="text-[length:var(--fs-small)] text-[var(--text-muted)]">h</span>
              <input
                aria-label="Minutes"
                type="number"
                min={0}
                max={59}
                value={minutes}
                onChange={(e) => {
                  setMinutes(e.target.value);
                  setError('');
                }}
                className={`${FIELD} num w-20`}
              />
              <span className="text-[length:var(--fs-small)] text-[var(--text-muted)]">min</span>
            </div>
            <p className={HINT}>
              Set the total time this task really took. Time already written into a log cannot be taken away here.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-[length:var(--fs-small)] text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-3 rounded-[var(--radius-btn)] text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-subtle)] cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="h-10 px-5 rounded-[var(--radius-btn)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] text-[length:var(--fs-body)] font-bold cursor-pointer"
          >
            Save
          </button>
        </div>
      </form>
    </ModalShell>
  );
};
