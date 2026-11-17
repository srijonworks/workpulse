import React, { useEffect, useId, useRef, useState } from 'react';
import { ModalShell } from '../ui/ModalShell';
import { localTimeStr } from '../../utils/dates';
import { chosenClockIn } from '../../utils/workday';
import { AUTO_CONFIRM_MS, shouldAutoConfirm } from '../../utils/autoDay/startPrompt';

interface ClockInDialogProps {
  isOpen: boolean;
  onClose(): void;
  /** ISO timestamp of the clock-in: now, or the chosen time (yesterday when it has not come yet today). */
  onConfirm(atIso: string, auto?: boolean): void;
  /** Set when the popup opened by itself: the time it suggests (ISO). The time field starts there. */
  suggestedAt?: string;
  /** The last time someone used the PC (ms). With `suggestedAt`, the popup confirms itself after 10 minutes if this moved. */
  getLastActivityMs?: () => number | null;
}

export const ClockInDialog: React.FC<ClockInDialogProps> = ({ isOpen, ...rest }) => (isOpen ? <ClockInPanel {...rest} /> : null);

// Mounted fresh on every open, so the time field starts at the current time.
const ClockInPanel: React.FC<Omit<ClockInDialogProps, 'isOpen'>> = ({ onClose, onConfirm, suggestedAt, getLastActivityMs }) => {
  const id = useId();
  const titleId = `${id}-title`;
  const timeId = `${id}-time`;
  const errorId = `${id}-error`;
  const [time, setTime] = useState(() => (suggestedAt ? localTimeStr(new Date(suggestedAt)) : localTimeStr()));
  const [error, setError] = useState('');

  // A time later than now means yesterday (clocking in after midnight for a late start).
  const chosen = chosenClockIn(time, Date.now());

  // Opened by itself: after 10 minutes it clocks in with the time in the field, but only if someone used the PC since it
  // appeared (so a PC left alone does not clock in). The time can be edited until then.
  const shownAt = useRef(Date.now());
  const timeRef = useRef(time);
  timeRef.current = time;
  useEffect(() => {
    if (!suggestedAt) return;
    const id = setInterval(() => {
      if (!shouldAutoConfirm({ shownAtMs: shownAt.current, nowMs: Date.now(), lastActivityMs: getLastActivityMs?.() ?? null })) return;
      const c = chosenClockIn(timeRef.current, Date.now());
      if (c) onConfirm(c.atIso, true);
    }, 15_000);
    return () => clearInterval(id);
  }, [suggestedAt, getLastActivityMs, onConfirm]);

  const confirmChosen = () => {
    if (!chosen) {
      setError('Enter the time you came in, for example 09:15.');
      return;
    }
    onConfirm(chosen.atIso);
  };

  return (
    <ModalShell
      onClose={onClose}
      labelledBy={titleId}
      closeOnBackdrop
      className="w-full max-w-sm p-6 bg-[var(--bg-surface-elevated)] text-[var(--text-main)] border border-[var(--border-app)] rounded-[var(--radius-card)]"
    >
      <h2 id={titleId} className="text-[length:var(--fs-body)] font-bold">
        Clock in
      </h2>
      <p className="mt-1 text-[length:var(--fs-small)] text-[var(--text-muted)]">
        {suggestedAt
          ? `You started working around ${localTimeStr(new Date(suggestedAt))}. Change the time if that is wrong; it confirms itself in ${AUTO_CONFIRM_MS / 60000} minutes.`
          : 'Start the workday now, or say when you came in.'}
      </p>

      <button
        type="button"
        data-autofocus
        onClick={() => onConfirm(suggestedAt && chosen ? chosen.atIso : new Date().toISOString())}
        className="mt-5 w-full h-11 rounded-[var(--radius-btn)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] text-[length:var(--fs-body)] font-bold cursor-pointer transition-colors"
      >
        Clock in
      </button>

      <div className="mt-5 pt-5 border-t border-[var(--border-app)]">
        <label htmlFor={timeId} className="block mb-1.5 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]">
          Came in earlier?
        </label>
        <div className="flex gap-2">
          <input
            id={timeId}
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmChosen();
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="num h-10 px-3 min-w-0 flex-1 rounded-[var(--radius-btn)] border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--text-main)] text-[length:var(--fs-body)] focus:border-[var(--border-focus)]"
          />
          <button
            type="button"
            onClick={confirmChosen}
            className="shrink-0 h-10 px-4 rounded-[var(--radius-btn)] border border-[var(--border-control)] hover:bg-[var(--bg-subtle)] text-[length:var(--fs-small)] font-semibold whitespace-nowrap cursor-pointer transition-colors"
          >
            I came in {chosen?.yesterday ? 'yesterday ' : ''}at <span className="num">{time || '--:--'}</span>
          </button>
        </div>
        {error && (
          <p id={errorId} role="alert" className="mt-2 text-[length:var(--fs-small)] text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="h-10 px-3 rounded-[var(--radius-btn)] text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-subtle)] cursor-pointer transition-colors"
        >
          Cancel
        </button>
      </div>
    </ModalShell>
  );
};
