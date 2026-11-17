import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { DatePicker } from '../ui/DatePicker';
import { Select } from '../ui/Select';
import { AlertTriangle, Loader2, RotateCw, Sparkles, X } from 'lucide-react';
import { ModalShell } from '../ui/ModalShell';
import { IconButton } from '../ui/IconButton';
import { localDateStr } from '../../utils/dates';
import { anyPromptSourceOn, byDisplayRank } from '../../utils/activity/registry';
import { ACTIVITY_SOURCES, type ActivitySource } from '../../utils/activity/registry';
import { describeSources, loadSuggestions, noticeSignature, type PipelineArgs } from '../../utils/activity/pipeline';
import { ActivitySessionRow, getActivitySession, rowTouched, setActivitySession, subscribeActivitySession } from '../../utils/activity/sessionStore';
import { suggestionToLogData, taskIdsOf, trackedMinutesFor } from '../../utils/activity/suggestions';
import { formatEstimate, formatMinutes } from '../../utils/activity/time';
import type { BacklogTask, Project, WorkLog } from '../../types';
import type { ActivityAi, ActivityFolder, ActivitySources } from '../../utils/activity/types';

export interface ActivitySuggestionsPanelProps {
  logs: WorkLog[];
  backlog: BacklogTask[];
  projects: Project[];
  folders: ActivityFolder[];
  sources: ActivitySources;
  ai: ActivityAi;
  geminiApiKey: string;
  /** Adds several logs in one go (one state update, one sheet sync). */
  onAddLogs: (logs: Omit<WorkLog, 'id' | 'createdAt'>[]) => void;
  onOpenSettings: () => void;
  /** How many suggestions are waiting (not added yet), reported after every scan and every add. */
  onPendingChange?: (count: number) => void;
  /** Called when a scan has finished and its suggestions are on screen. */
  onScanned?: () => void;
  /**
   * Embedded on a screen: one line per suggestion, edits open on demand, and nothing is read until
   * the user presses "Check activity" (full mode scans on open: opening the dialog is the asking).
   */
  compact?: boolean;
  /** Look for new activity every 5 minutes while this panel is on screen (today only, after the notice was accepted). */
  autoScan?: boolean;
  /** Done tasks with time waiting to be logged: merged with the activity into the same suggestions (End my day). */
  doneTasks?: BacklogTask[];
  /** The day to check (local YYYY-MM-DD). Compact mode follows it; full mode starts on it and has a day picker. Default: today. */
  date?: string;
  /** id for the heading (full mode), so a dialog can name itself after it. */
  titleId?: string;
  /** Extra controls at the end of the heading row (full mode), e.g. a close button. */
  headerEnd?: React.ReactNode;
  /** Which work is worth a log (see utils/activity/significance): small work waits in a "Maybe" list. */
  quality?: PipelineArgs['quality'];
}

interface ActivitySuggestionsDialogProps extends Omit<ActivitySuggestionsPanelProps, 'onPendingChange' | 'onScanned' | 'compact' | 'date' | 'titleId' | 'headerEnd'> {
  isOpen: boolean;
  onClose: () => void;
}

type Row = ActivitySessionRow;

const NOTICE_KEY = 'workpulse_activity_notice';
const AUTO_SCAN_MS = 5 * 60 * 1000;
const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const readAck = (): string => {
  try {
    return localStorage.getItem(NOTICE_KEY) ?? '';
  } catch {
    return '';
  }
};
const writeAck = (sig: string) => {
  try {
    localStorage.setItem(NOTICE_KEY, sig);
  } catch {
    // Not remembered: the notice simply shows again next time.
  }
};

const FIELD =
  'bg-[var(--bg-subtle)] border border-[var(--border-control)] rounded-[var(--radius-btn)] px-3 py-2 text-xs text-[var(--text-main)] focus:border-[var(--border-focus)]';

const PRIMARY =
  'px-4 py-2 text-xs font-semibold rounded-[var(--radius-btn)] bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] cursor-pointer';

// 'idle': nothing has been asked for yet, and nothing is read while it lasts. Full mode leaves it at
// once for 'notice' (first use, or a new source was switched on) or 'loading'; compact mode waits
// for "Check activity". 'ready' shows the day's session from the store (sessionStore).
type Phase = 'idle' | 'notice' | 'loading' | 'ready' | 'error';

/** The dialog: a ModalShell around the panel. Closing unmounts the panel, which drops any scan still running. */
export const ActivitySuggestionsDialog: React.FC<ActivitySuggestionsDialogProps> = ({ isOpen, onClose, onOpenSettings, ...rest }) => {
  if (!isOpen) return null;
  return (
    <ModalShell
      onClose={onClose}
      labelledBy="activity-title"
      backdropClassName="p-3 sm:p-4"
      className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-[var(--radius-card)] border overflow-hidden shadow-2xl bg-[var(--bg-surface-elevated)] border-[var(--border-app)] text-[var(--text-main)]"
    >
      <ActivitySuggestionsPanel
        {...rest}
        titleId="activity-title"
        onOpenSettings={() => {
          onClose();
          onOpenSettings();
        }}
        headerEnd={
          <IconButton label="Close" onClick={onClose}>
            <X className="w-5 h-5" />
          </IconButton>
        }
      />
    </ModalShell>
  );
};

/** The body of activity suggestions: data notice, scanning, rows to tick and edit, and Add. */
export const ActivitySuggestionsPanel: React.FC<ActivitySuggestionsPanelProps> = ({
  logs,
  backlog,
  projects,
  folders,
  sources,
  ai,
  geminiApiKey,
  onAddLogs,
  onOpenSettings,
  onPendingChange,
  onScanned,
  compact = false,
  autoScan = false,
  doneTasks,
  date: dateProp,
  titleId,
  headerEnd,
  quality,
}) => {
  const fallbackId = useId();
  const [pickedDate, setPickedDate] = useState(() => dateProp ?? localDateStr());
  const date = compact && dateProp ? dateProp : pickedDate;
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [runId, setRunId] = useState(0);
  // The day's check lives in the session store, shared with every other activity panel.
  const session = useSyncExternalStore(subscribeActivitySession, () => getActivitySession(date));
  const result = session?.result ?? null;
  const rows = session?.rows ?? [];
  const addedCount = session?.addedCount ?? 0;
  // Compact mode: the suggestion whose editor is open.
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const signature = noticeSignature(sources, ai);
  const tasksKey = (doneTasks ?? []).map((t) => t.id).sort().join('|');
  const hasSetup = (folders.length > 0 && ACTIVITY_SOURCES.some((d) => sources[d.id as ActivitySource])) || (doneTasks?.length ?? 0) > 0;
  const activeProjects = projects.filter((p) => !p.isArchived);

  // The scan reads the latest logs and tasks without re-running whenever they change
  // (adding logs from this panel changes them).
  const latest = useRef({ logs, backlog, projects, folders, sources, geminiApiKey, ai, doneTasks, tasksKey, quality });
  latest.current = { logs, backlog, projects, folders, sources, geminiApiKey, ai, doneTasks, tasksKey, quality };
  const callbacks = useRef({ onPendingChange, onScanned });
  callbacks.current = { onPendingChange, onScanned };

  // Only the newest scan may write its result: a slower, older one (date changed twice) is dropped.
  const scanSeq = useRef(0);

  // Asks to read the day's activity: through the notice when it has not been accepted for these sources.
  const start = () => {
    setPhase(readAck() === signature ? 'loading' : 'notice');
    setRunId((n) => n + 1);
  };

  // On mount: a day already checked this session shows its kept suggestions; otherwise full mode
  // starts a check (opening the dialog is the user asking) and compact mode waits for the button.
  // Unmounting drops any scan still running, so a reopened panel never acts on a stale phase.
  useEffect(() => {
    const kept = getActivitySession(date);
    // A kept check is reused, unless it was made without the done tasks this panel merges in.
    if (kept && (!doneTasks || kept.tasksKey === tasksKey)) setPhase('ready');
    else if (!compact || (autoScan && readAck() === signature)) start();
    return () => {
      scanSeq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async (forDate: string, background = false) => {
    const seq = ++scanSeq.current;
    const startedAt = Date.now();
    if (!background) setError('');
    try {
      const l = latest.current;
      const cur = getActivitySession(forDate);
      // A background check asks the AI again only when the activity or the tasks changed since the last one.
      const r = await loadSuggestions({
        date: forDate, folders: l.folders, sources: l.sources, projects: l.projects, logs: l.logs, backlog: l.backlog,
        geminiApiKey: l.geminiApiKey, ai: l.ai, tasks: l.doneTasks,
        sameAs: background ? cur?.result.itemsKey : undefined,
        quality: l.quality,
      });
      if (seq !== scanSeq.current) return;
      // A check the user asked for keeps its "Reading your activity..." in view for a moment, so a fast scan still shows it ran.
      if (!background) {
        const wait = 700 - (Date.now() - startedAt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (seq !== scanSeq.current) return;
      }
      const now = Date.now();
      if (r.unchanged && cur) {
        setActivitySession(forDate, { ...cur, checkedAt: now, tasksKey: l.tasksKey });
        return;
      }
      // Edits or ticks in progress are never replaced behind the user's back: the new result waits behind "Refresh".
      if (background && cur && cur.rows.some(rowTouched)) {
        setActivitySession(forDate, { ...cur, checkedAt: now, fresh: r });
        return;
      }
      setActivitySession(forDate, {
        result: r,
        rows: r.suggestions.map((s) => ({ suggestion: s, checked: false, text: s.text, projectId: s.projectId, minutes: String(s.minutes), subtasks: s.subtasks.join('\n') })),
        addedCount: cur && background ? cur.addedCount : 0,
        checked: true,
        checkedAt: now,
        tasksKey: l.tasksKey,
      });
      if (!background) {
        setEditingKey(null);
        setPhase('ready');
      }
      callbacks.current.onScanned?.();
    } catch (err) {
      if (seq !== scanSeq.current || background) return; // a background check fails quietly and tries again later
      setError(err instanceof Error ? err.message : 'Reading your activity failed.');
      setPhase('error');
    }
  }, []);

  // Runs whenever the panel is loading: on a check, on a different day, on retry, and once the
  // notice is accepted.
  useEffect(() => {
    if (hasSetup && phase === 'loading') void run(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSetup, date, runId, phase === 'loading']);

  // Live checking: every 5 minutes while this panel shows today's suggestions and the tab is visible, and
  // once on coming back to the tab after a longer pause. Only after the notice was accepted.
  useEffect(() => {
    if (!autoScan || !hasSetup || phase === 'loading' || phase === 'notice' || date !== localDateStr()) return;
    const tick = () => {
      if (document.visibilityState === 'visible' && readAck() === signature && getActivitySession(date)) void run(date, true);
    };
    const onVisible = () => {
      const c = getActivitySession(date);
      if (document.visibilityState === 'visible' && c && Date.now() - c.checkedAt > AUTO_SCAN_MS) tick();
    };
    const id = window.setInterval(tick, AUTO_SCAN_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [autoScan, hasSetup, phase, date, signature, run]);

  // What is on screen: a check in progress or waiting for the notice, an error, the day's kept
  // session, or (no session) the "Check activity" button in compact mode / the spinner while full
  // mode decides.
  const view: Phase | 'check' =
    phase === 'notice' || phase === 'loading' || phase === 'error' ? phase : session ? 'ready' : compact ? 'check' : 'idle';

  // Suggestions still waiting. App reads pendingCount() from the store; this is for a screen's own use.
  useEffect(() => {
    if (view === 'ready') callbacks.current.onPendingChange?.(rows.length);
  }, [view, rows.length]);

  // Every change goes to the store, so other panels (and a later visit) see the same rows and edits.
  const writeRows = (next: (prev: Row[]) => Row[], added = 0) => {
    const cur = getActivitySession(date);
    if (!cur) return;
    setActivitySession(date, { ...cur, rows: next(cur.rows), addedCount: cur.addedCount + added });
  };

  const update = (key: string, patch: Partial<Row>) =>
    writeRows((prev) => prev.map((r) => (r.suggestion.key === key ? { ...r, ...patch } : r)));

  const chosen = rows.filter((r) => r.checked);
  const canAdd = chosen.length > 0 && chosen.every((r) => r.text.trim().length > 0);
  const allChecked = rows.length > 0 && rows.every((r) => r.checked);

  const handleAdd = () => {
    if (!canAdd) return;
    onAddLogs(
      chosen.map((r) => {
        const name = projects.find((p) => p.id === r.projectId)?.name ?? r.suggestion.projectName;
        const minutes = Math.max(0, Math.round(Number(r.minutes)) || 0);
        return suggestionToLogData(r.suggestion, date, minutes, r.text.trim(), r.projectId, name, r.subtasks.split('\n'));
      }),
    );
    writeRows((prev) => prev.filter((r) => !r.checked), chosen.length);
  };

  const acceptNotice = () => {
    writeAck(signature);
    setPhase('loading');
    setRunId((n) => n + 1);
  };


  const sourceLines = result ? describeSources(sources, result.status) : [];

  // The editable fields of one suggestion: text, sub-tasks, project, minutes, evidence and the
  // already-tracked warning. Shown for every row in full mode, and for the opened row in compact mode.
  const renderEditor = (r: Row) => {
    const s = r.suggestion;
    const unchanged = Number(r.minutes) === s.minutes;
    // Live, not frozen at scan time: counts logs added from this panel and a changed project.
    const tracked = trackedMinutesFor(date, r.projectId, logs, backlog, new Set(taskIdsOf(s.itemIds)));
    return (
      <>
        <div className="pl-6">
          <label className="block text-xs text-[var(--text-muted)] mb-1" htmlFor={`sub-${s.key}`}>
            Sub-tasks, one per line. They are listed under the log.
          </label>
          <textarea
            id={`sub-${s.key}`}
            value={r.subtasks}
            onChange={(e) => update(s.key, { subtasks: e.target.value })}
            rows={Math.min(8, Math.max(2, r.subtasks.split('\n').length))}
            className={`w-full resize-y ${FIELD}`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <Select inline compact ariaLabel="Project" value={r.projectId} onChange={(v) => update(s.key, { projectId: v })} options={[...(activeProjects.some((p) => p.id === r.projectId) ? [] : [{ value: r.projectId, label: s.projectName }]), ...activeProjects.map((p) => ({ value: p.id, label: p.name }))]} />
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <input
              type="number"
              min={0}
              value={r.minutes}
              onChange={(e) => update(s.key, { minutes: e.target.value })}
              aria-label="Minutes"
              className={`w-20 ${FIELD}`}
            />
            <span>min</span>
          </label>
          <span className="text-xs text-[var(--text-muted)]">{unchanged ? formatEstimate(s.minutes) : 'edited by you'}</span>
        </div>
        <p className="pl-6 text-xs text-[var(--text-muted)]">From: {s.evidence}</p>
        {tracked > 0 && (
          <p className="pl-6 text-xs text-warning">You already have {formatMinutes(tracked)} tracked or logged for this project on this day.</p>
        )}
      </>
    );
  };

  // A new check of the same day: replaces the kept suggestions (and any edits) with a fresh scan.
  const scanAgain = (
    <button
      type="button"
      onClick={start}
      className="shrink-0 inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 px-2 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)] hover:text-[var(--text-main)] cursor-pointer"
    >
      <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
      Scan again
    </button>
  );

  const settingsButton = (
    <button type="button" onClick={onOpenSettings} className={PRIMARY}>
      Open Settings
    </button>
  );

  const body = !hasSetup ? (
    <div className={compact ? 'py-2 space-y-2' : 'py-10 text-center space-y-3'}>
      <p className="text-sm font-semibold">
        {folders.length === 0 ? 'Link a folder to a project first.' : 'Turn on at least one source first.'}
      </p>
      <p className="text-xs text-[var(--text-muted)]">
        Suggestions come from the folders linked to your projects in Settings. Nothing else on this computer is read.
      </p>
      {settingsButton}
    </div>
  ) : view === 'check' ? (
    <div className="py-1 space-y-3">
      <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">
        Turn today's commits{anyPromptSourceOn(sources) ? ' and AI-tool prompts' : ''} into log lines you can tick and add. Nothing is read until you ask.
      </p>
      <button type="button" onClick={start} className={PRIMARY}>
        Check activity
      </button>
    </div>
  ) : view === 'notice' ? (
    <div className={compact ? 'py-1 space-y-3' : 'py-8 max-w-lg mx-auto space-y-4'}>
      <h3 className="text-sm font-bold">Before the first scan</h3>
      <ul className="text-xs text-[var(--text-muted)] space-y-1.5 list-disc pl-5">
        {ai === 'none' ? (
          <li>Nothing is sent anywhere: the log text is written on this computer from your commits and prompts.</li>
        ) : (
          <>
            {byDisplayRank().filter((d) => (sources as Record<string, boolean | undefined>)[d.id]).map((d) => (
              <li key={d.id}>{d.noticeLine(ai === 'claude' ? 'Claude' : 'Gemini')}</li>
            ))}
            {(doneTasks?.length ?? 0) > 0 && <li>The titles of your done tasks go to {ai === 'claude' ? 'Claude' : 'Gemini'} too, so it can match them with your activity.</li>}
            <li>Anything that looks like a key or password is hidden first.</li>
          </>
        )}
        <li>File contents and command output never leave your computer.</li>
        {ai !== 'none' && <li>If the AI is not available, the text is written from the same material on this computer instead.</li>}
      </ul>
      <button type="button" onClick={acceptNotice} className={PRIMARY}>
        Continue
      </button>
    </div>
  ) : view === 'loading' || view === 'idle' ? (
    <div className={compact ? 'py-3 flex items-center gap-2' : 'py-16 text-center space-y-3'} role="status">
      <Loader2 className={`${compact ? 'w-4 h-4' : 'w-9 h-9 mx-auto'} text-[var(--accent-text)] animate-spin`} aria-hidden="true" />
      <p className="text-sm font-semibold">Reading your activity...</p>
    </div>
  ) : view === 'error' ? (
    <div className={`${compact ? 'p-3 space-y-2' : 'p-6 text-center space-y-3'} border border-danger/30 bg-danger/10 rounded-[var(--radius-card)]`}>
      {!compact && <AlertTriangle className="w-8 h-8 text-danger mx-auto" aria-hidden="true" />}
      <p className="text-sm font-semibold text-danger">{error}</p>
      <div className={`flex gap-2 ${compact ? '' : 'justify-center'}`}>
        <button
          type="button"
          onClick={() => setPhase('loading')}
          className="px-4 py-1.5 text-xs font-semibold rounded-[var(--radius-btn)] bg-[var(--text-main)] text-[var(--bg-app)] hover:opacity-90 cursor-pointer"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="px-4 py-1.5 text-xs font-semibold rounded-[var(--radius-btn)] bg-[var(--bg-subtle)] text-[var(--text-main)] hover:bg-[var(--bg-subtle-hover)] cursor-pointer"
        >
          Open Settings
        </button>
      </div>
    </div>
  ) : (
    <>
      {result?.notice && (
        <p role="status" className="text-xs p-2.5 rounded-[var(--radius-btn)] border border-warning/30 bg-warning/10 text-[var(--text-main)]">
          {result.notice}
        </p>
      )}
      {session?.fresh && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-xs p-2.5 rounded-[var(--radius-btn)] border border-[var(--accent)]/40 bg-[var(--accent)]/10">
          <span>New activity found while you were editing.</span>
          <button
            type="button"
            onClick={() => {
              const f = session.fresh;
              if (!f) return;
              setActivitySession(date, {
                result: f,
                rows: f.suggestions.map((s) => ({ suggestion: s, checked: false, text: s.text, projectId: s.projectId, minutes: String(s.minutes), subtasks: s.subtasks.join('\n') })),
                addedCount: session.addedCount,
                checked: true,
                checkedAt: Date.now(),
                tasksKey,
              });
            }}
            className="shrink-0 font-semibold text-[var(--accent-text)] hover:underline underline-offset-4 cursor-pointer"
          >
            Refresh
          </button>
        </div>
      )}
      {!compact && (
        <div className="flex items-start justify-between gap-3">
          <ul className="text-xs text-[var(--text-muted)] space-y-0.5">
            {sourceLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="shrink-0 flex flex-col items-end">
            {scanAgain}
            {session && <span className="text-xs text-[var(--text-muted)]">Checked {timeOf(session.checkedAt)}</span>}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className={compact ? 'py-1 space-y-1' : 'py-10 text-center space-y-1'}>
          <p className="text-sm font-semibold">
            {addedCount > 0 ? `Added ${addedCount} ${addedCount === 1 ? 'log' : 'logs'}. Nothing else is waiting.` : compact ? 'Nothing new in your activity today.' : 'No new activity found for this day.'}
          </p>
          {!compact && (
            <p className="text-xs text-[var(--text-muted)]">
              {addedCount > 0 ? 'Close this window or pick another day.' : 'Pick another day, or check the folders and sources in Settings.'}
            </p>
          )}
          {compact && addedCount === 0 && sourceLines.length > 0 && (
            <ul className="text-[length:var(--fs-small)] text-[var(--text-muted)] space-y-0.5">
              {sourceLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      ) : compact ? (
        <ul>
          {rows.map((r) => {
            const s = r.suggestion;
            const open = editingKey === s.key;
            const projectName = projects.find((p) => p.id === r.projectId)?.name ?? s.projectName;
            const minutes = Math.max(0, Math.round(Number(r.minutes)) || 0);
            return (
              <li key={s.key} className="py-[var(--row-pad)] border-b border-[var(--border-app)] space-y-2.5">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={r.checked}
                    onChange={(e) => update(s.key, { checked: e.target.checked })}
                    aria-label={`Add: ${r.text.slice(0, 60)}`}
                    className="mt-1 w-4 h-4 shrink-0 accent-[var(--accent-text)]"
                  />
                  <div className="flex-1 min-w-0">
                    {open ? (
                      <textarea
                        value={r.text}
                        onChange={(e) => update(s.key, { text: e.target.value })}
                        aria-label="Log text"
                        rows={2}
                        className={`w-full resize-y ${FIELD}`}
                      />
                    ) : (
                      <p className="text-[length:var(--fs-body)] font-semibold break-words">{r.text}</p>
                    )}
                    <p className="mt-1 text-[length:var(--fs-small)] text-[var(--text-muted)]">
                      {projectName} · {s.evidence} · {Number(r.minutes) === s.minutes ? formatEstimate(minutes) : `${formatMinutes(minutes)}, edited by you`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingKey(open ? null : s.key)}
                    aria-expanded={open}
                    className="shrink-0 min-h-8 pointer-coarse:min-h-11 px-2 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] hover:underline underline-offset-4 cursor-pointer"
                  >
                    {open ? 'Done editing' : 'Edit'}
                  </button>
                </div>
                {open && renderEditor(r)}
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          <ul className="space-y-3">
            {rows.map((r) => {
              const s = r.suggestion;
              return (
                <li key={s.key} className="p-3 rounded-[var(--radius-card)] border border-[var(--border-control)] bg-[var(--bg-subtle)] space-y-2.5">
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={r.checked}
                      onChange={(e) => update(s.key, { checked: e.target.checked })}
                      aria-label={`Add: ${r.text.slice(0, 60)}`}
                      className="mt-2"
                    />
                    <textarea
                      value={r.text}
                      onChange={(e) => update(s.key, { text: e.target.value })}
                      aria-label="Log text"
                      rows={2}
                      className={`flex-1 resize-y ${FIELD}`}
                    />
                  </div>
                  {renderEditor(r)}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {compact && (session?.result.maybe?.length ?? 0) > 0 && (
        <div className="mt-3 border-t border-[var(--border-app)] pt-3">
          <p className="text-[length:var(--fs-small)] font-semibold text-[var(--text-main)]">Maybe</p>
          <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">Small pieces of work. They are not added by themselves; more work on the same project turns them into a log.</p>
          <ul className="mt-1">
            {(session?.result.maybe ?? []).map((m) => (
              <li key={m.key} className="flex items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[length:var(--fs-small)] text-[var(--text-main)]" title={m.text}>
                  {m.projectName} · {m.evidence} · {formatEstimate(m.minutes)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onAddLogs([suggestionToLogData(m, date, m.minutes, m.text, m.projectId, m.projectName, m.subtasks)]);
                    const cur = getActivitySession(date);
                    if (cur) setActivitySession(date, { ...cur, result: { ...cur.result, maybe: (cur.result.maybe ?? []).filter((x) => x.key !== m.key) } });
                  }}
                  className="shrink-0 min-h-8 pointer-coarse:min-h-11 px-2 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] hover:underline underline-offset-4 cursor-pointer"
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );

  const footer = hasSetup && view === 'ready' && rows.length > 0 && (
    <div className={`flex items-center justify-between gap-3 shrink-0 ${compact ? 'pt-3' : 'p-4 border-t border-[var(--border-app)]'}`}>
      <span className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
        <span>{compact ? `${chosen.length} of ${rows.length} selected` : `${chosen.length} selected`}</span>
        <button
          type="button"
          onClick={() => writeRows((prev) => prev.map((r) => ({ ...r, checked: !allChecked })))}
          className="font-semibold text-[var(--accent-text)] hover:underline underline-offset-4 min-h-8 pointer-coarse:min-h-11 cursor-pointer"
        >
          {allChecked ? 'Clear selection' : 'Select all'}
        </button>
      </span>
      <button
        type="button"
        onClick={handleAdd}
        disabled={!canAdd}
        className="px-5 py-2 text-xs sm:text-sm font-semibold rounded-[var(--radius-btn)] bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {compact
          ? chosen.length > 0
            ? `Add ${chosen.length} ${chosen.length === 1 ? 'log' : 'logs'}`
            : 'Add selected'
          : chosen.length > 0
            ? `Add ${chosen.length} selected`
            : 'Add selected'}
      </button>
    </div>
  );

  if (compact) {
    return (
      <div>
        {body}
        {footer}
        {hasSetup && (view === 'ready' || view === 'error') && (
          <div className="pt-2 flex items-center justify-end gap-3">
            {session && view === 'ready' && <span role="status" className="text-[length:var(--fs-small)] text-[var(--text-muted)]">Checked {timeOf(session.checkedAt)} · {rows.length === 0 ? 'nothing new' : `${rows.length} found`}</span>}
            {session && view !== 'ready' && <span className="text-[length:var(--fs-small)] text-[var(--text-muted)]">Checked {timeOf(session.checkedAt)}</span>}
            {scanAgain}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5 border-b border-[var(--border-app)] shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-[var(--accent)]/10 text-[var(--accent-text)] border border-[var(--accent)]/30">
            <Sparkles className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h2 id={titleId ?? fallbackId} className="text-base sm:text-lg font-bold">Suggest logs from my activity</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">Tick the ones that are right. You can edit them before adding.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
            <span>Day</span>
            <DatePicker
              ariaLabel="Day"
              className="min-w-[10rem]"
              value={date}
              max={localDateStr()}
              onChange={(next) => {
                if (!next) return;
                setPickedDate(next);
                // A day already checked this session shows what was kept; any other day is read now.
                if (getActivitySession(next)) setPhase('ready');
                else if (phase !== 'notice') setPhase('loading');
              }}
            />
          </div>
          {headerEnd}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">{body}</div>

      {footer}
    </>
  );
};
