import React from 'react';
import type { BacklogTask, Project, WorkdayRecord } from '../../types';
import { clockState, formatClock, formatHm, formatHms, type ClockState } from '../../utils/workday';
import { buildOvers, workBuckets } from '../../utils/segments';
import { localTimeStr, parseLocalDate } from '../../utils/dates';
import type { ThemeId } from '../../utils/theme';
import type { SheetSendState } from '../../utils/sheetSendState';
import { OversStrip } from './OversStrip';
import { useNow } from './useNow';

interface ClockBandProps {
  theme: ThemeId;
  /** Local YYYY-MM-DD. */
  today: string;
  /** Today's workday record, if clocked in today. */
  record?: WorkdayRecord;
  /** An earlier day still clocked in (openWorkdayBefore). Shown instead of today's clock. */
  staleOpen: { date: string; rec: WorkdayRecord } | null;
  /** Workday length in hours. */
  hours: number;
  tasks: BacklogTask[];
  projects: Project[];
  onClockIn(): void;
  onClockOut(date: string): void;
  onResume(date: string): void;
  /** After a clock-out: whether the Google Sheet has the day (it sends the email from it). Absent = no Sheet linked. */
  sheet?: SheetSendState | null;
  /** Pushes to the Sheet again now (shown when the last push failed). */
  onRetrySheet?(): void;
}

const SHEET_TEXT: Record<SheetSendState, string> = {
  sent: 'Sent to your Sheet',
  sending: 'Sending to your Sheet…',
  failed: 'Not sent to your Sheet yet. Keep the PC on.',
};

const hhmm = (ms: number) => localTimeStr(new Date(ms));

const PAD: Record<ThemeId, string> = {
  chase: 'px-4 md:px-6 lg:px-8 py-4',
  timecard: 'px-4 md:px-6 lg:px-8 py-3.5',
  console: 'px-4 md:px-6 py-2.5',
  nightdesk: 'px-4 md:px-6 py-2.5',
};

const SMALL = 'text-[length:var(--fs-small)]';
const BODY = 'text-[length:var(--fs-body)]';
const BIG = 'num font-bold leading-[0.9] tracking-[-0.01em] text-[length:var(--fs-num)]';

const BandButton: React.FC<{
  theme: ThemeId;
  tone?: 'plain' | 'out';
  onClick(): void;
  className?: string;
  children: React.ReactNode;
}> = ({ theme, tone = 'plain', onClick, className = '', children }) => {
  const look =
    theme === 'chase'
      ? `${BODY} font-semibold px-4 rounded-[var(--radius-btn)] border-[1.5px] border-[var(--band-ink)] hover:bg-[var(--band-line)]`
      : theme === 'timecard'
        ? `${SMALL} font-extrabold uppercase tracking-[0.1em] px-4 border-2 hover:bg-[var(--band-line)] ${
            // Small red text uses --danger (5.27:1 on the manila band); the --clock reds are for big figures.
            tone === 'out' ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--band-ink)]'
          }`
        : `${SMALL} font-medium px-3 rounded-[var(--radius-btn)] border border-[var(--band-line)] hover:bg-[var(--bg-surface-elevated)]`;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 inline-flex items-center justify-center whitespace-nowrap min-h-10 max-sm:min-h-11 cursor-pointer transition-colors ${look} ${className}`}
    >
      {children}
    </button>
  );
};

const Meter: React.FC<{ pct: number; className?: string }> = ({ pct, className = '' }) => (
  <div aria-hidden="true" className={`overflow-hidden rounded-[calc(var(--radius-btn)/2)] bg-[var(--band-line)] ${className}`}>
    <div className="h-full bg-[var(--clock)]" style={{ width: `${pct}%` }} />
  </div>
);

/** "+0:12 over" while past the leave time, otherwise the time left. */
const RemainingValue: React.FC<{ s: ClockState; tone: string }> = ({ s, tone }) =>
  s.phase === 'over' ? (
    <>
      <span className={tone}>+{formatHms(s.overSec)}</span>
      <span className={`${SMALL} ml-1 font-semibold tracking-normal text-[var(--band-ink)]`}>over</span>
    </>
  ) : (
    <>{formatHms(s.leftSec)}</>
  );

export const ClockBand: React.FC<ClockBandProps> = ({
  theme,
  today,
  record,
  staleOpen,
  hours,
  tasks,
  projects,
  onClockIn,
  onClockOut,
  onResume,
  sheet,
  onRetrySheet,
}) => {
  const now = useNow(1000);
  const s = clockState(record, hours, now);
  const pad = PAD[theme];
  // --clock colours pass AA only as large figures; Console and Night Desk figures are body size, so they stay ink there.
  const tone = theme === 'console' || theme === 'nightdesk' ? '' : 'text-[var(--clock)]';

  let body: React.ReactNode;

  if (staleOpen) {
    const day = parseLocalDate(staleOpen.date).toLocaleDateString('en-US', { weekday: 'short' });
    body = (
      <div className={`flex flex-wrap items-center gap-x-6 gap-y-3 ${pad}`}>
        <p className={`${BODY} font-semibold`}>
          Clocked in since {day} <span className="num">{hhmm(Date.parse(staleOpen.rec.clockIn))}</span>
        </p>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <BandButton theme={theme} tone="out" onClick={() => onClockOut(staleOpen.date)}>
            Clock out
          </BandButton>
          {!record && (
            <BandButton theme={theme} onClick={onClockIn}>
              Clock in for today
            </BandButton>
          )}
        </div>
      </div>
    );
  } else if (s.phase === 'off') {
    body = (
      <div className={`flex flex-wrap items-center gap-x-6 gap-y-3 ${pad}`}>
        <p className={`${BODY} font-semibold`}>Not clocked in</p>
        <BandButton theme={theme} onClick={onClockIn} className="ml-auto">
          Clock in
        </BandButton>
      </div>
    );
  } else if (s.phase === 'out') {
    body = (
      <div className={`flex flex-wrap items-center gap-x-6 gap-y-3 ${pad}`}>
        <p className={`${BODY} font-semibold`}>
          Out at <span className="num">{record?.clockOut ? hhmm(Date.parse(record.clockOut)) : ''}</span>
          <span className="text-[var(--band-muted)]"> · </span>
          worked <span className="num">{formatHm(s.workedSec)}</span>
        </p>
        {sheet && (
          <p
            role="status"
            data-sheet={sheet}
            className={`${SMALL} font-semibold ${sheet === 'failed' ? 'text-[var(--band-alert)]' : 'text-[var(--band-muted)]'}`}
          >
            {sheet === 'sent' && <span aria-hidden="true">✓ </span>}
            {SHEET_TEXT[sheet]}
          </p>
        )}
        <div className="flex flex-wrap gap-2 ml-auto">
          {sheet === 'failed' && onRetrySheet && (
            <BandButton theme={theme} tone="out" onClick={onRetrySheet}>
              Send again
            </BandButton>
          )}
          <BandButton theme={theme} onClick={() => onResume(today)}>
            Resume
          </BandButton>
        </div>
      </div>
    );
  } else {
    const target = hours * 3600;
    const scale = Math.max(target, s.workedSec, 1);
    const pct = Math.min(100, (s.workedSec / scale) * 100);
    const leaveAt = s.leaveAtMs ?? now;
    const clockOut = (
      <BandButton theme={theme} tone="out" onClick={() => onClockOut(today)}>
        Clock out
      </BandButton>
    );

    // Under md every theme shows now / to go and a thin meter.
    const compact = (
      <div className="md:hidden px-4 py-3">
        <div className="flex items-end gap-2.5">
          <div>
            <div className={`${SMALL} font-semibold uppercase tracking-[0.12em] text-[var(--band-muted)] mb-1`}>Now</div>
            <div className={`${BIG} ${tone}`}>{formatClock(now)}</div>
          </div>
          <div>
            <div className={`${SMALL} font-semibold uppercase tracking-[0.12em] text-[var(--band-muted)] mb-1`}>
              To go · <span className="num">{hhmm(leaveAt)}</span>
            </div>
            <div className={BIG}>
              <RemainingValue s={s} tone={tone} />
            </div>
          </div>
          <div className="ml-auto [&_button]:!px-2 [&_button]:!tracking-[0.04em]">{clockOut}</div>
        </div>
        <Meter pct={pct} className="mt-3 h-1" />
      </div>
    );

    let wide: React.ReactNode;
    if (theme === 'chase') {
      const overs = record ? buildOvers(record, hours, tasks, projects, now) : [];
      const label = `${SMALL} font-semibold uppercase tracking-[0.12em] text-[var(--band-muted)] mb-1.5`;
      wide = (
        <div className="hidden md:grid grid-cols-[auto_auto_auto_1fr_auto] items-center gap-8 lg:gap-12 px-6 lg:px-8 pt-[18px] pb-[22px]">
          <div>
            <div className={label}>In</div>
            <div className={BIG}>{hhmm(s.clockInMs ?? now)}</div>
          </div>
          <div>
            <div className={label}>Now</div>
            <div className={`${BIG} ${tone}`}>{formatClock(now)}</div>
          </div>
          <div>
            <div className={label}>
              To go · leave <span className="num">{hhmm(leaveAt)}</span>
            </div>
            <div className={BIG}>
              <RemainingValue s={s} tone={tone} />
            </div>
          </div>
          <div className="min-w-0">
            <div className="hidden lg:block">
              <OversStrip overs={overs} />
            </div>
            <Meter pct={pct} className="lg:hidden h-1.5" />
          </div>
          {clockOut}
        </div>
      );
    } else if (theme === 'timecard') {
      // One block per 15 minutes from clock-in to the leave time (or now); each fills from the bottom by how much of it was worked.
      const SLOT = 15 * 60_000;
      const fromMs = Math.floor((s.clockInMs ?? now) / SLOT) * SLOT;
      const toMs = Math.ceil(Math.max(leaveAt, now) / SLOT) * SLOT;
      const buckets = workBuckets(tasks, fromMs, toMs, now, SLOT);
      const nowIdx = Math.floor((now - fromMs) / SLOT);
      const cell = 'pt-3.5 pb-4 pr-5 mr-5 lg:pr-7 lg:mr-7 border-r border-[var(--band-line)]';
      const label = `${SMALL} font-bold uppercase tracking-[0.14em] text-[var(--band-muted)] mb-1`;
      const value = 'num font-bold leading-none text-[length:var(--fs-num)]';
      wide = (
        <div className="hidden md:flex items-stretch px-6 lg:px-8">
          <div className={`${cell} hidden lg:block`}>
            <div className={label}>In</div>
            <div className={value}>{hhmm(s.clockInMs ?? now)}</div>
          </div>
          <div className={cell}>
            <div className={label}>Now</div>
            <div className={`${value} ${tone}`}>{formatClock(now)}</div>
          </div>
          <div className={cell}>
            <div className={label}>To go</div>
            <div className={value}>
              <RemainingValue s={s} tone={tone} />
            </div>
          </div>
          <div className={cell}>
            <div className={label}>Out at</div>
            <div className={`${value} text-[var(--clock-over)]`}>{hhmm(leaveAt)}</div>
          </div>
          <div
            role="img"
            aria-label={`Work by hour: ${buckets.map((v, i) => `${hhmm(fromMs + i * SLOT)} ${Math.round(v * 60)} min`).join(', ')}`}
            className="self-center flex-1 min-w-16 mr-5 lg:mr-7 flex gap-px"
          >
            {buckets.map((v, i) => (
              <div
                key={i}
                title={`${hhmm(fromMs + i * SLOT)} to ${hhmm(fromMs + (i + 1) * SLOT)}: ${Math.round(v * 60)} min worked`}
                className={`relative flex-1 h-[38px] flex items-end bg-[var(--band-bg)] ${i === nowIdx ? 'border-2' : 'border'} border-[var(--band-ink)] min-w-0`}
              >
                <div className="w-full bg-[var(--clock)]" style={{ height: `${Math.round(v * 100)}%` }} />
              </div>
            ))}
          </div>
          <div className="self-center">{clockOut}</div>
        </div>
      );
    } else {
      wide = (
        <div className="hidden md:flex items-center gap-[18px] px-6 py-2.5 num text-[length:var(--fs-num)]">
          <span className="flex items-center gap-2 h-8 px-3 rounded-[var(--radius-btn)] border border-[var(--band-line)]">
            <span aria-hidden="true" className="size-2 rounded-full bg-[var(--clock)]" />
            in {hhmm(s.clockInMs ?? now)}
          </span>
          <span>now {formatClock(now)}</span>
          <Meter pct={pct} className="w-[180px] h-1.5" />
          {s.phase === 'over' ? (
            <span className="font-semibold">+{formatHms(s.overSec)} over</span>
          ) : (
            <span className="text-[var(--band-muted)]">left {formatHms(s.leftSec)}</span>
          )}
          <div className="ml-auto font-[family-name:var(--font-body)]">{clockOut}</div>
        </div>
      );
    }

    body = (
      <>
        {compact}
        {wide}
      </>
    );
  }

  return (
    <section
      aria-label="Workday clock"
      data-phase={s.phase}
      className="v2-band v2-clock bg-[var(--band-bg)] text-[var(--band-ink)]"
    >
      {body}
    </section>
  );
};
