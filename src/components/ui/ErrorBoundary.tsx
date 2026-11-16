import React from 'react';
import { health } from '../../utils/health/registry';
import { safeDetail } from '../../utils/health/redact';
import { crashReloadDecision, createErrorReporter, resetKeysChanged, type ErrorReport } from '../../utils/health/reportError';

// Catches an error in the part of the screen below it, so one broken screen or dialog does not blank the whole app.
// The error goes to the health registry (and to the log file once the app connects `setErrorSink`), and the user gets
// a plain sentence with a way forward.

export type BoundaryVariant = 'root' | 'screen' | 'dialog' | 'inline' | 'widget';

let sink: ((r: ErrorReport) => void) | null = null;
/** The app connects its log here; errors reported before that still reach the health registry. */
export const setErrorSink = (fn: ((r: ErrorReport) => void) | null) => {
  sink = fn;
};

const reporter = createErrorReporter({
  report: (r) => {
    health.reportFail('app', { message: r.message, detail: r.detail, retryable: true });
    sink?.(r);
  },
});
/** Reports an error that was not caught anywhere else. */
export const reportUnhandled = (area: string, error: unknown): void => reporter(area, error);

const RELOAD_KEY = 'workpulse_crash_reload_at';
const readReloadAt = (): number | null => {
  try {
    const n = Number(sessionStorage.getItem(RELOAD_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};
const writeReloadAt = (t: number) => {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(t));
  } catch {
    // without it the page simply may reload once more than intended
  }
};

interface Props {
  /** Where this boundary sits ("History", "Add log dialog"): said in the report, never shown as a stack. */
  area: string;
  variant: BoundaryVariant;
  /** When one of these changes (the user opened another tab) the children are tried again. */
  resetKeys?: readonly unknown[];
  /** Dialog: closes the dialog that broke. */
  onClose?: () => void;
  /** Root: saves everything before the page reloads. */
  onBeforeReload?: () => void;
  /** Root: a sentence about when data was last saved. */
  savedNote?: () => string | null;
  children: React.ReactNode;
}

interface State {
  error: unknown;
  failed: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, failed: false };
  private timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown): void {
    reportUnhandled(this.props.area, error);
    if (this.props.variant === 'root') this.recoverRoot();
    if (this.props.variant === 'widget') this.timer = setTimeout(() => window.location.reload(), 5000);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.failed && resetKeysChanged(prev.resetKeys, this.props.resetKeys)) this.setState({ error: null, failed: false });
  }

  componentWillUnmount(): void {
    clearTimeout(this.timer);
  }

  // Saves first, then reloads once; a second crash within five minutes stays on the screen below instead of looping.
  private recoverRoot(): void {
    try {
      this.props.onBeforeReload?.();
    } catch {
      // the reload below must still happen
    }
    const now = Date.now();
    if (crashReloadDecision({ now, lastReloadAt: readReloadAt() })) {
      writeReloadAt(now);
      window.location.reload();
    }
  }

  private retry = () => this.setState({ error: null, failed: false });

  private close = () => {
    this.props.onClose?.();
    this.retry();
  };

  private reload = () => {
    try {
      this.props.onBeforeReload?.();
    } catch {
      // reload anyway
    }
    window.location.reload();
  };

  private copy = () => {
    const text = `WorkPulse problem in ${this.props.area}: ${safeDetail(this.state.error) || 'no details'}`;
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    const { variant } = this.props;
    const button = 'v2-btn inline-flex items-center justify-center min-h-11 px-4 cursor-pointer';
    const strong = `${button} v2-btn-strong`;

    if (variant === 'inline') {
      return (
        <span role="alert" className="text-[length:var(--fs-small)] text-[var(--text-muted)]">
          Not available right now.
        </span>
      );
    }
    if (variant === 'widget') {
      return (
        <div role="alert" className="wg p-3 text-[length:var(--fs-small)]">
          This widget stopped. Reloading it.
        </div>
      );
    }
    if (variant === 'root') {
      const note = this.props.savedNote?.();
      return (
        <div role="alert" className="min-h-screen grid place-items-center p-6 bg-[var(--bg-app)] text-[var(--text-main)]">
          <div className="v2-panel max-w-md w-full p-6 flex flex-col gap-4">
            <h1 className="text-[length:var(--fs-body)] font-bold">WorkPulse ran into a problem</h1>
            <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">
              {note ? `${note} ` : ''}Reload to carry on. If it keeps happening, copy the details and keep them.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={this.reload} className={strong}>
                Reload WorkPulse
              </button>
              <button type="button" onClick={this.copy} className={button}>
                Copy details
              </button>
            </div>
          </div>
        </div>
      );
    }
    if (variant === 'dialog') {
      // The dialog that broke is gone, so this stands in for it, over the page like a dialog does.
      return (
        <div role="alertdialog" aria-modal="true" aria-label="A window ran into a problem" className="fixed inset-0 z-[100] grid place-items-center p-4 bg-black/45">
          <div className="v2-panel max-w-sm w-full p-5 flex flex-col gap-3 bg-[var(--bg-surface-elevated)] text-[var(--text-main)]">
            <h2 className="text-[length:var(--fs-body)] font-bold">This window ran into a problem</h2>
            <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">Your data is not affected. Close this window and open it again.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" autoFocus onClick={this.close} className={strong}>
                Close
              </button>
              <button type="button" onClick={this.copy} className={button}>
                Copy details
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <section role="alert" className="mx-auto max-w-[44rem] p-6">
        <div className="v2-panel p-5 flex flex-col gap-3">
          <h2 className="text-[length:var(--fs-body)] font-bold">This screen ran into a problem</h2>
          <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">
            Your data is not affected. Try again, or open another tab and come back.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={this.retry} className={strong}>
              Try again
            </button>
            <button type="button" onClick={this.copy} className={button}>
              Copy details
            </button>
          </div>
        </div>
      </section>
    );
  }
}
