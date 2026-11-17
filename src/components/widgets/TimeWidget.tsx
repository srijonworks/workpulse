import React from 'react';
import { X } from 'lucide-react';
import { clockState, formatClock, formatHm, formatHms } from '../../utils/workday';
import { isSnapshotStale } from '../../utils/widgets';
import { localTimeStr } from '../../utils/dates';
import { formatMinutes } from '../v2/today/LogRow';
import { desktopBridge } from '../../utils/desktopBridge';
import type { WidgetSnapshot } from '../../utils/widgets';
import { useNow } from '../v2/useNow';

// Today's time and the time left in the workday, in the band colours of the current theme.
export const TimeWidget: React.FC<{ snap: WidgetSnapshot | null }> = ({ snap }) => {
  const now = useNow(1000);
  const rec = snap?.clockIn ? { clockIn: snap.clockIn, clockOut: snap.clockOut ?? undefined } : undefined;
  const c = clockState(rec, snap?.hours ?? 8, now);
  const label =
    c.phase === 'off' ? 'Office clock' : c.phase === 'out' ? 'Worked today' : c.phase === 'over' ? 'Over by' : 'Time left';
  const big =
    c.phase === 'off'
      ? '--:--:--'
      : c.phase === 'out'
        ? formatHm(c.workedSec)
        : c.phase === 'over'
          ? formatHms(c.overSec)
          : formatHms(c.leftSec);
  const stale = !!snap && isSnapshotStale(snap, now);
  const sub =
    c.phase === 'off'
      ? snap
        ? 'Not clocked in'
        : 'Waiting for WorkPulse…'
      : c.phase === 'out'
        ? `In ${localTimeStr(new Date(c.clockInMs as number))} · out ${localTimeStr(new Date(Date.parse(snap?.clockOut as string)))}`
        : `Leave ${localTimeStr(new Date(c.leaveAtMs as number))}`;
  const figures = snap && c.phase !== 'off' ? `Worked ${formatHm(c.workedSec)} / Logged ${formatMinutes(snap.loggedMinutes)}` : '';
  const problem = snap?.problems[0];
  const action =
    snap && c.phase === 'off' ? { label: 'Clock in', command: { type: 'clock-in' } as const }
    : snap && c.phase !== 'out' ? { label: 'End my day', command: { type: 'end-day' } as const }
    : null;

  return (
    <div className="wg relative flex h-screen flex-col justify-center gap-1.5 overflow-hidden rounded-[var(--radius-card)] border border-[var(--band-line)] bg-[var(--band-bg)] px-4 py-4 text-[var(--band-ink)]">
      <div className="flex items-baseline justify-between gap-3 pr-6 text-[length:var(--fs-small)] text-[var(--band-muted)]">
        <span className="font-semibold uppercase tracking-[0.08em]">{label}</span>
        <span className="num">{formatClock(now)}</span>
      </div>
      <div
        className="num text-[34px] font-bold leading-none"
        style={{ color: c.phase === 'off' || c.phase === 'out' ? undefined : `var(--clock-${c.phase})` }}
      >
        {big}
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[length:var(--fs-small)] text-[var(--band-muted)]">
        <span className="truncate">{sub}</span>
        {stale && <span className="shrink-0 font-semibold text-[var(--clock-over)]">Not updating</span>}
      </div>
      {figures && <div className="num text-[length:var(--fs-small)] text-[var(--band-muted)]">{figures}</div>}
      {problem && !stale && <div className="truncate text-[length:var(--fs-small)] text-[var(--clock-over)]" title={problem}>{problem}</div>}
      {action && (
        <button
          type="button"
          onClick={() => desktopBridge()?.command(action.command)}
          className="wg-btn mt-0.5 h-7 w-fit cursor-pointer rounded-[var(--radius-btn)] border border-[var(--band-line)] px-3 text-[length:var(--fs-small)] font-semibold text-[var(--band-ink)] hover:bg-[var(--band-line)]"
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Hide this widget"
        title="Hide this widget"
        onClick={() => desktopBridge()?.command({ type: 'close', kind: 'time' })}
        className="wg-btn absolute right-1 top-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-[var(--radius-btn)] text-[var(--band-muted)] hover:text-[var(--band-ink)]"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
};
