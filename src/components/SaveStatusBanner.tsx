import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { EngineStatus } from '../utils/persist/engine';
import { KEY_LABELS } from '../utils/storage';

interface Props {
  status: EngineStatus;
  onRetry: () => void;
  onDownloadBackup: () => void;
  /** Take over writing in this window (the other window becomes read-only). */
  onUseThisWindow: () => void;
  /** The user chooses to start this list empty instead of restoring it. */
  onStartEmpty: (key: string) => void;
}

const label = (key: string) => KEY_LABELS[key] ?? key;

const BAR =
  'no-print flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 rounded-[var(--radius-card)] border border-danger/50 bg-[var(--bg-surface)] text-[var(--text-main)]';
const BTN =
  'px-3 py-1.5 text-xs font-semibold rounded-[var(--radius-btn)] border border-[var(--border-control)] hover:bg-[var(--bg-subtle)] cursor-pointer';

/**
 * Says so, and stays, whenever something the user did is not in storage, a list could not be read, or this window
 * may not write. It goes away by itself the moment saving works again. It is never a toast that fades.
 */
export const SaveStatusBanner: React.FC<Props> = ({ status, onRetry, onDownloadBackup, onUseThisWindow, onStartEmpty }) => {
  const dirty = status.dirtyKeys.filter((k) => !status.blockedKeys.includes(k));
  if (!status.frozen && status.blockedKeys.length === 0 && dirty.length === 0) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="save-status">
      {status.frozen && (
        <div role="alert" className={BAR}>
          <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="flex-1 min-w-[16rem] text-sm">
            <strong className="font-semibold">WorkPulse is open in another window.</strong>{' '}
            <span className="text-[var(--text-muted)]">This one is read-only, so the two cannot overwrite each other's changes.</span>
          </p>
          <button type="button" onClick={onUseThisWindow} className={BTN}>
            Use this window
          </button>
        </div>
      )}

      {status.blockedKeys.map((key) => (
        <div role="alert" key={key} className={BAR}>
          <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="flex-1 min-w-[16rem] text-sm">
            <strong className="font-semibold">Your {label(key)} could not be read from this browser's storage.</strong>{' '}
            <span className="text-[var(--text-muted)]">
              WorkPulse is not changing them, so nothing is written over what is there. A copy of the damaged data was kept. Import a
              backup file in Settings, or start this list empty.
            </span>
          </p>
          <button type="button" onClick={() => onStartEmpty(key)} className={BTN}>
            Start {label(key)} empty
          </button>
        </div>
      ))}

      {dirty.length > 0 && (
        <div role="alert" className={BAR}>
          <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="flex-1 min-w-[16rem] text-sm">
            <strong className="font-semibold">Not saved yet.</strong>{' '}
            <span className="text-[var(--text-muted)]">
              {status.lastError ?? 'This browser did not accept the save.'} Your {dirty.map(label).join(', ')} are kept in this window and
              WorkPulse keeps trying. Download a backup file to be safe.
            </span>
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={onRetry} className={BTN}>
              Try again
            </button>
            <button type="button" onClick={onDownloadBackup} className={BTN}>
              Download backup
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
