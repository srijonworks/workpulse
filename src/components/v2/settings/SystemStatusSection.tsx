import React from 'react';
import { Copy } from 'lucide-react';
import { buildDiagnostics, type StatusAction, type StatusState, type SystemStatus } from '../../../utils/systemStatus';

const HINT = 'text-[length:var(--fs-small)] text-[var(--text-muted)]';
const BTN =
  'v2-btn inline-flex items-center justify-center gap-1.5 min-h-11 px-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

const STATE_WORD: Record<StatusState, string> = { ok: 'OK', warn: 'Needs a look', bad: 'Problem' };
const STATE_COLOR: Record<StatusState, string> = {
  ok: 'text-[var(--text-muted)]',
  warn: 'text-[var(--text-main)]',
  bad: 'text-danger',
};
const ACTION_LABEL: Record<StatusAction, string> = {
  retry: 'Try again',
  'open-settings': 'Open settings',
  'download-backup': 'Download a backup',
};
const DAY_WORD = { done: 'closed, logs added', empty: 'closed, nothing to add', waiting: 'not closed' } as const;

const timeText = (ms?: number): string => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet');

// Settings > System status: one row per part of WorkPulse, in plain words. Presentational: App builds the status.
export const SystemStatusSection: React.FC<{
  status: SystemStatus;
  nowMs: number;
  onAction: (action: StatusAction) => void;
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}> = ({ status, nowMs, onAction, onNotify }) => {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildDiagnostics(status, nowMs));
      onNotify('Diagnostics copied. They hold counts and states only.', 'success');
    } catch {
      onNotify('Could not copy. Your browser did not allow it.', 'error');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col" aria-label="System status">
        {status.rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-[var(--border-app)] py-3 first:border-t-0 first:pt-0">
            <div className="min-w-0 flex-1">
              <p className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">
                {r.label} <span className={`${STATE_COLOR[r.state]} text-[length:var(--fs-small)] font-semibold`}>{STATE_WORD[r.state]}</span>
              </p>
              <p className={HINT}>{r.sentence}</p>
              {r.lastOkAt !== undefined && <p className={HINT}>Last worked: {timeText(r.lastOkAt)}</p>}
            </div>
            {r.action && (
              <button type="button" className={BTN} onClick={() => onAction(r.action as StatusAction)}>
                {ACTION_LABEL[r.action]}
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2 border-t border-[var(--border-app)] pt-5">
        <h3 className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">Storage</h3>
        <p className={HINT}>
          {(status.storage.bytes / 1024 / 1024).toFixed(1)} MB used, {status.storage.percent}% of what this browser allows.
          {status.storage.nearlyFull ? ' It is nearly full.' : ''}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-[var(--border-app)] pt-5">
        <h3 className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">Automatic day, last 7 days</h3>
        <ul className="flex flex-col gap-1">
          {status.dayClose.map((d) => (
            <li key={d.date} className={`${HINT} num`}>
              {d.date}: {DAY_WORD[d.state]}
              {d.state === 'done' ? ` (${d.added})` : ''}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2 border-t border-[var(--border-app)] pt-5">
        <h3 className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">Repairs</h3>
        {status.repairs.length === 0 ? (
          <p className={HINT}>Nothing needed repair.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {status.repairs.map((r, i) => (
              <li key={`${r.at}-${i}`} className={HINT}>
                {r.at ? `${timeText(Date.parse(r.at))}: ` : ''}
                {r.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col items-start gap-2 border-t border-[var(--border-app)] pt-5">
        <h3 className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">Diagnostics</h3>
        <p className={HINT}>Copies counts and states only. No logs, names, addresses or keys.</p>
        <button type="button" className={BTN} onClick={copy}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          <span>Copy diagnostics</span>
        </button>
      </div>
    </div>
  );
};
