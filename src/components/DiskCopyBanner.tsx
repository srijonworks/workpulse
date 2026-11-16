import React, { useState } from 'react';
import { AlertTriangle, History } from 'lucide-react';
import type { MirrorState } from '../utils/persist/diskMirror';
import type { RestoreOffer } from '../hooks/useDiskCopy';
import { localDateOfIso } from '../utils/dates';

interface Props {
  offer: RestoreOffer | null;
  state: MirrorState;
  onRestore: () => Promise<string | null>;
  onKeep: () => void;
}

const BAR =
  'no-print flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 rounded-[var(--radius-card)] border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--text-main)]';
const BTN =
  'px-3 py-1.5 text-xs font-semibold rounded-[var(--radius-btn)] border border-[var(--border-control)] hover:bg-[var(--bg-subtle)] cursor-pointer disabled:opacity-50';

const FAIL_SHOWN_AFTER_MS = 10 * 60 * 1000;

const what = (c: RestoreOffer['counts']) => `${c.logs} logs, ${c.tasks} tasks, ${c.projects} projects`;

/**
 * Offers to bring back the copy kept on this computer (when this browser holds nothing, is behind the copy, or could not
 * read a list), and says so when the copy has not been written for a while. Stays until answered.
 */
export const DiskCopyBanner: React.FC<Props> = ({ offer, state, onRestore, onKeep }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failingLong = state.kind === 'failing' && Date.now() - state.since >= FAIL_SHOWN_AFTER_MS;
  if (!offer && !failingLong) return null;

  const restore = async () => {
    setBusy(true);
    setError(null);
    const e = await onRestore();
    if (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="disk-copy">
      {offer && (
        <div role="alert" className={BAR}>
          <History className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="flex-1 min-w-[16rem] text-sm">
            <strong className="font-semibold">
              {offer.reason === 'blocked' ? 'A list could not be read here, but this computer has a copy.' : offer.reason === 'behind' ? 'This computer has a newer copy of your data.' : 'This browser has none of your data, but this computer has a copy.'}
            </strong>{' '}
            <span className="text-[var(--text-muted)]">
              Saved {offer.savedAt ? localDateOfIso(offer.savedAt) : 'earlier'}: {what(offer.counts)}. What is here now is kept first.
            </span>
            {error && <span className="block text-danger mt-1">{error}</span>}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={restore} disabled={busy} className={BTN}>
              {busy ? 'Restoring…' : 'Restore my data'}
            </button>
            {offer.reason !== 'blocked' && (
              <button type="button" onClick={onKeep} disabled={busy} className={BTN}>
                Keep what is here
              </button>
            )}
          </div>
        </div>
      )}
      {failingLong && (
        <div role="alert" className={BAR}>
          <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="flex-1 min-w-[16rem] text-sm">
            <strong className="font-semibold">The copy of your data on this computer has not been updated for a while.</strong>{' '}
            <span className="text-[var(--text-muted)]">{state.kind === 'failing' ? state.message : ''} WorkPulse keeps trying.</span>
          </p>
        </div>
      )}
    </div>
  );
};
