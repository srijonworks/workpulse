import React, { useState, useEffect } from 'react';
import { Select } from './ui/Select';
import { ModalShell } from './ui/ModalShell';
import { plainAiMessage } from '../utils/aiErrors';
import { requestJson } from '../utils/net/http';
import { AI_REQUEST_TIMEOUT_MS } from '../utils/net/timeouts';
import { IconButton } from './ui/IconButton';
import { localDateStr } from '../utils/dates';
import { isEodCandidate, withUnloggedTime } from '../utils/taskLogging';
import { modelLabel } from '../utils/geminiModels';
import { buildBuckets, eodRequestBody, eodUsesTemplateOnFailure, templateLog } from '../utils/eodSynthesis';
import type { ActivityAi } from '../utils/activity/types';
import { minutesFromSeconds } from '../utils/duration';
import { BacklogTask, Project, TaskStatus, TaskStage } from '../types';
import {
  ClipboardCheck,
  RefreshCw,
  Info,
  CheckCircle2,
  Clock,
  Ban,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  X,
  Send,
  Loader2,
  CheckSquare,
  Square,
  Flame,
  Terminal,
  FileText,
  Sparkles,
} from 'lucide-react';

export interface SynthesizedLogItem {
  id: string; // unique split ID e.g. `${projectId}_${status}`
  splitId?: string;
  projectId: string;
  projectName: string;
  projectColor?: string;
  status: TaskStatus;
  durationMinutes: number;
  summaryBullets: string;
  tags: string[];
  taskIds: string[];
  underlyingTasks: {
    id: string;
    title: string;
    stage: TaskStage;
    elapsedSeconds: number;
    excluded?: boolean;
  }[];
}

interface EodSynthesizerModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasksSnapshot?: BacklogTask[];
  isCustomSelection?: boolean;
  backlog?: BacklogTask[];
  projects: Project[];
  /** Who writes the text (the AI writer setting). 'none' builds the template text here, with no server call. */
  ai: ActivityAi;
  /** Only sent to the server when `ai` is 'gemini'. */
  geminiApiKey: string;
  hasGoogleSheetLinked: boolean;
  onConfirmAndPush: (items: SynthesizedLogItem[]) => Promise<void>;
  /** Opens the activity suggestions dialog (logs suggested from git commits and Claude Code history). */
  onOpenActivity?: () => void;
}

function formatDurationSeconds(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export interface EodPanelProps extends Omit<EodSynthesizerModalProps, 'isOpen' | 'onClose'> {
  /** Called after the chosen logs were confirmed (onConfirmAndPush resolved). */
  onDone?(): void;
  /** Shows the Close / Cancel buttons (the modal wrapper passes its onClose). */
  onCancel?(): void;
  /** id for the heading (full mode). */
  titleId?: string;
  /** Inside End my day: no dialog heading or Sheet status line, and the confirm button reads "Add N logs". */
  embedded?: boolean;
}

// The modal keeps its old props. The body is mounted on each open, so the synthesis runs once per open.
export const EodSynthesizerModal: React.FC<EodSynthesizerModalProps> = ({ isOpen, onClose, ...rest }) => {
  if (!isOpen) return null;
  return (
    <ModalShell
      onClose={onClose}
      labelledBy="eod-title"
      backdropClassName="p-3 sm:p-4"
      className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-[var(--radius-card)] border overflow-hidden bg-[var(--bg-surface-elevated)] border-[var(--border-app)] text-[var(--text-main)]"
    >
      <EodPanel {...rest} titleId="eod-title" onCancel={onClose} onDone={onClose} />
    </ModalShell>
  );
};

/** The end-of-day synthesis body: builds one log per project and status from the tasks, then confirms the chosen ones. */
export const EodPanel: React.FC<EodPanelProps> = ({
  tasksSnapshot,
  isCustomSelection = false,
  backlog,
  projects,
  ai,
  geminiApiKey,
  hasGoogleSheetLinked,
  onConfirmAndPush,
  onOpenActivity,
  onDone,
  onCancel,
  titleId,
  embedded = false,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // A failure to reach the service can be retried; "nothing new to log" cannot.
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [synthesizedItems, setSynthesizedItems] = useState<SynthesizedLogItem[]>([]);
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set());
  const [expandedMicroTasks, setExpandedMicroTasks] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [activeModelName, setActiveModelName] = useState<string>('AI');


  // Static snapshot reference to prevent 1-second timer intervals from re-triggering API calls
  const tasksSource = tasksSnapshot || backlog || [];
  const frozenTasksRef = React.useRef<BacklogTask[]>([]);
  const hasRunRef = React.useRef(false);

  const runSynthesis = async (tasksToUse: BacklogTask[]) => {
    setIsLoading(true);
    setErrorMsg(null);
    setErrorRetryable(false);
    setAiWarning(null);
    // Never keep results from an earlier run: they could be pushed a second time (B4).
    setSynthesizedItems([]);
    setSelectedLogIds(new Set());

    const todayStr = localDateStr();

    // Scoping (see isEodCandidate): fully logged tasks are never offered again; tasks with new
    // time since their last log are.
    const candidateTasks = tasksToUse.filter((t) => isEodCandidate(t, todayStr, isCustomSelection));

    if (candidateTasks.length === 0) {
      setIsLoading(false);
      setErrorMsg(
        isCustomSelection
          ? 'Selected tasks have no new time to log (tasks that were already logged are skipped).'
          : 'All of today\'s tasks are already logged. Only tasks with new activity are included in later syntheses.'
      );
      return;
    }

    try {
      const tasksToSend = candidateTasks.map(withUnloggedTime);
      let data: any;
      if (ai === 'none') {
        // No AI: the template text is built here and nothing is sent anywhere.
        const buckets = buildBuckets(tasksToSend, projects.filter((p) => p && p.id));
        data = { synthesizedLogs: buckets.map(templateLog), isAIGenerated: false };
      } else {
        // A time limit, and a plain sentence for every failure (see utils/net/http).
        const resp = await requestJson<any>('/api/synthesize-eod', {
          method: 'POST',
          body: eodRequestBody(ai, tasksToSend, projects, todayStr, geminiApiKey),
          timeoutMs: AI_REQUEST_TIMEOUT_MS,
        });

        if (!resp.ok) {
          const errData = (resp.data && typeof resp.data === 'object' ? resp.data : {}) as { error?: string };
          if (eodUsesTemplateOnFailure(ai, false)) {
            // Claude refused (not the local setup) or failed: same offline templates as the "no AI" setting, with the reason shown.
            const buckets = buildBuckets(tasksToSend, projects.filter((p) => p && p.id));
            data = {
              synthesizedLogs: buckets.map(templateLog),
              isAIGenerated: false,
              apiError: true,
              notice: errData.error || plainAiMessage(resp.message),
            };
          } else {
            throw new Error(errData.error || resp.message);
          }
        } else {
          data = resp.data;
        }
      }
      const logs: SynthesizedLogItem[] = (Array.isArray(data.synthesizedLogs) ? data.synthesizedLogs : []).map((item: any) => ({
        ...item,
        // Never trust the response shape: a missing list must not crash the modal (C4).
        taskIds: Array.isArray(item.taskIds) ? item.taskIds : [],
        underlyingTasks: Array.isArray(item.underlyingTasks) ? item.underlyingTasks : [],
        summaryBullets: typeof item.summaryBullets === 'string' ? item.summaryBullets : '',
        tags: Array.isArray(item.tags) ? item.tags : [],
        durationMinutes: typeof item.durationMinutes === 'number' ? item.durationMinutes : 0,
        id: item.id || item.splitId || `${item.projectId}_${item.status}`,
      }));

      setSynthesizedItems(logs);
      setSelectedLogIds(new Set(logs.map((l) => l.id)));

      if (data.modelUsed) {
        setActiveModelName(modelLabel(data.modelUsed).toUpperCase());
      } else {
        setActiveModelName('TEMPLATE');
      }

      if (data.apiError || data.apiKeyMissing || (data.fallbackSplitIds && data.fallbackSplitIds.length > 0)) {
        setAiWarning(data.notice || 'AI synthesis unavailable. Formatted via status-separated fallback.');
        setAiNote(null);
      } else if (data.notice) {
        setAiNote(data.notice);
      } else if (data.isAIGenerated) {
        setAiNote(`Synthesized via ${modelLabel(data.modelUsed)} into status-separated project timesheets.`);
      }
    } catch (err: any) {
      console.error('Synthesis error:', err);
      setErrorMsg(plainAiMessage(err?.message));
      setErrorRetryable(true);
    } finally {
      setIsLoading(false);
    }
  };

  // Trigger synthesis strictly ONCE per mount (one modal opening, or one End my day session)
  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;

    // Freeze snapshot at opening time
    frozenTasksRef.current = [...tasksSource];
    runSynthesis(frozenTasksRef.current);
  }, []);

  const handleManualResynthesize = () => {
    const tasksToUse = frozenTasksRef.current.length > 0 ? frozenTasksRef.current : tasksSource;
    runSynthesis(tasksToUse);
  };

  const toggleSelectLog = (logId: string) => {
    setSelectedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(logId)) next.delete(logId);
      else next.add(logId);
      return next;
    });
  };

  const toggleExpandMicroTasks = (logId: string) => {
    setExpandedMicroTasks((prev) => {
      const next = new Set(prev);
      if (next.has(logId)) next.delete(logId);
      else next.add(logId);
      return next;
    });
  };

  const handleToggleUnderlyingTask = (logId: string, taskId: string) => {
    setSynthesizedItems((prev) =>
      prev.map((item) => {
        if (item.id !== logId) return item;
        const updatedTasks = item.underlyingTasks.map((t) =>
          t.id === taskId ? { ...t, excluded: !t.excluded } : t
        );
        const activeTasks = updatedTasks.filter((t) => !t.excluded);
        const newTotalSecs = activeTasks.reduce((acc, t) => acc + (t.elapsedSeconds || 0), 0);
        const newDuration = minutesFromSeconds(newTotalSecs);

        if (activeTasks.length === 0) {
          setSelectedLogIds((s) => {
            const next = new Set(s);
            next.delete(logId);
            return next;
          });
        }

        return {
          ...item,
          underlyingTasks: updatedTasks,
          taskIds: activeTasks.map((t) => t.id),
          durationMinutes: newDuration,
        };
      })
    );
  };

  const handleUpdateItem = (logId: string, field: keyof SynthesizedLogItem, val: any) => {
    setSynthesizedItems((prev) =>
      prev.map((item) => (item.id === logId ? { ...item, [field]: val } : item))
    );
  };

  const handleConfirm = async () => {
    const toPush = synthesizedItems
      .filter((item) => selectedLogIds.has(item.id))
      .map((item) => {
        const activeTasks = item.underlyingTasks.filter((t) => !t.excluded);
        return {
          ...item,
          taskIds: activeTasks.map((t) => t.id),
          underlyingTasks: activeTasks,
        };
      })
      .filter((item) => item.taskIds.length > 0);

    if (toPush.length === 0) {
      setPushError('Select at least one log that still has a task in it.');
      return;
    }
    setPushError(null);
    setIsSubmitting(true);
    try {
      await onConfirmAndPush(toPush);
      onDone?.();
    } catch (e: any) {
      setPushError(`Could not push the logs: ${e?.message || 'unknown error'}. Nothing was lost; press the button to try again.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
      <>
        {/* Modal Header */}
        {embedded ? (
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--border-app)] shrink-0">
            <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">
              One log per project and status from these tasks. Check the text and minutes, then add them.
              <span className="ml-2 font-semibold uppercase">{activeModelName}</span>
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleManualResynthesize}
                disabled={isLoading}
                className="v2-btn inline-flex items-center gap-1.5 min-h-8 pointer-coarse:min-h-11 px-3 cursor-pointer disabled:opacity-50 disabled:cursor-default"
              >
                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
                <span>Rebuild</span>
              </button>
            </div>
          </div>
        ) : (
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-[var(--border-app)] shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-[var(--accent)]/10 text-[var(--accent-text)] border border-[var(--accent)]/30">
              <ClipboardCheck className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id={titleId} className="text-base sm:text-lg font-bold flex items-center gap-2">
                <span>End-of-day timesheet</span>
                <span className="text-xs px-2 py-0.5 rounded-full font-mono font-bold bg-warning/15 text-warning border border-warning/30 uppercase">
                  {activeModelName}
                </span>
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                One log per project and status from today's tasks. Check them, then push to the Sheet.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleManualResynthesize}
              disabled={isLoading}
              className="px-2.5 py-1 text-xs font-medium rounded-[var(--radius-btn)] border border-[var(--border-control)] hover:border-[var(--text-main)] bg-[var(--bg-subtle)] text-[var(--text-main)] flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              title="Build the logs again from today's tasks"
            >
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">Rebuild</span>
            </button>
            {onCancel && (
              <IconButton label="Close" onClick={onCancel}>
                <X className="w-5 h-5" />
              </IconButton>
            )}
          </div>
        </div>
        )}

        {/* Modal Body / Review Console */}
        <div className={embedded ? 'py-4 space-y-5' : 'flex-1 overflow-y-auto p-4 sm:p-6 space-y-5'}>
          {onOpenActivity && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-[var(--radius-card)] border border-[var(--border-control)] bg-[var(--bg-subtle)]">
              <p className="text-xs text-[var(--text-muted)]">
                Did work today that you did not track? Pick logs from your git commits and Claude Code history.
              </p>
              <button
                type="button"
                onClick={onOpenActivity}
                className="px-3 py-1.5 text-xs font-semibold rounded-[var(--radius-btn)] border border-[var(--border-control)] hover:border-[var(--accent)] bg-[var(--bg-surface)] text-[var(--text-main)] flex items-center gap-1.5 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Suggest from my activity</span>
              </button>
            </div>
          )}
          {isLoading ? (
            <div className="py-16 text-center space-y-4">
              <Loader2 className="w-10 h-10 mx-auto text-[var(--accent-text)] animate-spin" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">Synthesizing status-separated timesheet logs...</p>
                <p className="text-xs text-[var(--text-muted)]">
                  Splitting by Project × Stage, calculating times, and writing professional executive summaries.
                </p>
              </div>
            </div>
          ) : errorMsg ? (
            <div className="p-6 text-center space-y-3 border border-danger/30 bg-danger/10 rounded-[var(--radius-card)]">
              <AlertTriangle className="w-8 h-8 text-danger mx-auto" />
              <p className="text-sm font-semibold text-danger">{errorMsg}</p>
              {errorRetryable && (
                <button
                  onClick={handleManualResynthesize}
                  className="px-4 py-1.5 mr-2 text-xs font-semibold rounded-[var(--radius-btn)] bg-[var(--text-main)] text-[var(--bg-app)] hover:opacity-90 cursor-pointer"
                >
                  Try again
                </button>
              )}
              {onCancel && (
                <button
                  onClick={onCancel}
                  className="px-4 py-1.5 text-xs font-semibold rounded-[var(--radius-btn)] bg-[var(--bg-subtle)] text-[var(--text-main)] hover:bg-[var(--bg-subtle-hover)] cursor-pointer"
                >
                  Close
                </button>
              )}
            </div>
          ) : synthesizedItems.length === 0 ? (
            <div className="py-12 text-center text-xs text-[var(--text-muted)] font-mono">
              No project items generated.
            </div>
          ) : (
            <>
              {pushError && (
                <div role="alert" className="p-3 rounded-[var(--radius-btn)] border border-danger/40 bg-danger/10 text-xs text-danger">
                  {pushError}
                </div>
              )}
              {aiWarning && (
                <div className="p-3.5 rounded-[var(--radius-card)] bg-warning/10 border border-warning/30 text-xs text-warning flex items-center justify-between gap-3 shadow-xs">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                    <span className="leading-relaxed">{aiWarning}</span>
                  </div>
                  <button
                    onClick={() => setAiWarning(null)}
                    className="p-1 hover:text-white rounded hover:bg-warning/20 transition-colors cursor-pointer shrink-0"
                    title="Dismiss notification"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {aiNote && (
                <div className="p-3 rounded-[var(--radius-btn)] bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-main)] flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-[var(--accent-text)] shrink-0" aria-hidden="true" />
                    <span>{aiNote}</span>
                  </span>
                  <span className="text-xs font-mono text-[var(--text-muted)]">
                    {selectedLogIds.size} of {synthesizedItems.length} status-split logs selected
                  </span>
                </div>
              )}

              {/* List of Status-Separated Project Logs */}
              <div className="space-y-4">
                {synthesizedItems.map((item) => {
                  const isSelected = selectedLogIds.has(item.id);
                  const isExpanded = expandedMicroTasks.has(item.id);
                  const activeTasks = item.underlyingTasks.filter((t) => !t.excluded);

                  const textareaThemeClass =
                    'bg-[var(--bg-surface-elevated)] border-[var(--border-control)] text-[var(--text-main)] focus:border-[var(--border-focus)]';

                  return (
                    <div
                      key={item.id}
                      className={`p-4 rounded-[var(--radius-card)] border transition-all space-y-3 ${
                        isSelected
                          ? item.status === 'blocked'
                            ? 'border-danger/70 bg-danger/5 ring-1 ring-danger/20'
                            : item.status === 'in_progress'
                            ? 'border-warning/70 bg-warning/5 ring-1 ring-warning/20'
                            : 'border-[var(--border-focus)] bg-[var(--bg-surface)]'
                          : 'border-[var(--border-app)] bg-[var(--bg-subtle)]/40 opacity-60'
                      }`}
                    >
                      {/* Project & Status Split Header Row */}
                      <div className="flex flex-wrap items-center justify-between gap-2.5 pb-2.5 border-b border-[var(--border-app)]">
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() => toggleSelectLog(item.id)}
                            className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--accent-text)] transition-colors"
                          >
                            {isSelected ? (
                              <CheckSquare className="w-4 h-4 text-[var(--accent-text)]" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </button>

                          <div className="flex items-center gap-2 font-bold text-sm">
                            <span
                              className="w-2.5 h-2.5 rounded-full inline-block"
                              style={{ backgroundColor: item.projectColor || '#6366f1' }}
                            />
                            <span>{item.projectName}</span>
                          </div>

                          {/* Distinct Status Pill */}
                          <span
                            className={`text-xs px-2 py-0.5 rounded font-mono font-bold uppercase tracking-wider ${
                              item.status === 'completed'
                                ? 'bg-success/20 text-success border border-success/30'
                                : item.status === 'blocked'
                                ? 'bg-danger/20 text-danger border border-danger/30'
                                : 'bg-warning/20 text-warning border border-warning/30'
                            }`}
                          >
                            {item.status.replace('_', ' ')}
                          </span>

                          <span className="text-xs font-mono text-[var(--text-muted)]">
                            ({activeTasks.length} of {item.underlyingTasks.length} tasks included)
                          </span>
                        </div>

                        {/* Status & Duration Controls */}
                        <div className="flex items-center gap-2 text-xs">
                          {/* Fine-tune Status Picker */}
                          <Select
                            inline
                            compact
                            ariaLabel="Status"
                            value={item.status}
                            onChange={(v) => handleUpdateItem(item.id, 'status', v as TaskStatus)}
                            options={[
                              { value: 'completed', label: 'Completed' },
                              { value: 'in_progress', label: 'In Progress' },
                              { value: 'blocked', label: 'Blocked' },
                            ]}
                          />

                          {/* Duration Input */}
                          <div className="flex items-center gap-1 bg-[var(--bg-subtle)] border border-[var(--border-app)] rounded-[var(--radius-btn)] px-2 py-1">
                            <Clock className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                            <input
                              type="number"
                              aria-label="Duration in minutes"
                              min={0}
                              max={720}
                              value={item.durationMinutes}
                              onChange={(e) =>
                                handleUpdateItem(
                                  item.id,
                                  'durationMinutes',
                                  Math.max(0, parseInt(e.target.value) || 0)
                                )
                              }
                              className="w-12 text-xs font-mono font-bold bg-transparent text-[var(--text-main)]"
                            />
                            <span className="text-xs text-[var(--text-muted)]">mins</span>
                          </div>
                        </div>
                      </div>

                      {/* Editable Synthesized Bullets */}
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-[var(--text-muted)] flex items-center justify-between">
                          <span>Synthesized Timesheet Description (Markdown Bullets):</span>
                          <span className="text-xs font-mono font-normal">Editable</span>
                        </label>
                        <textarea
                          rows={Math.max(3, item.summaryBullets.split('\n').length)}
                          value={item.summaryBullets}
                          onChange={(e) =>
                            handleUpdateItem(item.id, 'summaryBullets', e.target.value)
                          }
                          className={`w-full text-sm leading-relaxed p-3.5 rounded-[var(--radius-card)] border resize-y transition-all ${textareaThemeClass}`}
                        />
                      </div>

                      {/* Interactive Micro-Tasks Checklist (Uncheck to Exclude) */}
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => toggleExpandMicroTasks(item.id)}
                          className="flex items-center gap-1.5 text-xs text-[var(--accent-text)] hover:underline font-semibold cursor-pointer"
                        >
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          <span>
                            {isExpanded ? 'Hide' : 'Review & Filter'} Underlying Micro-Tasks ({activeTasks.length}/{item.underlyingTasks.length})
                          </span>
                        </button>

                        {isExpanded && (
                          <div className="mt-2 p-2.5 rounded-[var(--radius-btn)] bg-[var(--bg-subtle)]/70 border border-[var(--border-app)] space-y-2 animate-in fade-in duration-150">
                            <p className="text-xs text-[var(--text-muted)] font-mono">
                              Uncheck tasks below to exclude them from this timesheet entry and reduce logged duration:
                            </p>
                            <div className="space-y-1">
                              {item.underlyingTasks.map((t) => (
                                <div
                                  key={t.id}
                                  onClick={() => handleToggleUnderlyingTask(item.id, t.id)}
                                  className={`flex items-center justify-between gap-2 text-xs py-1 px-2 rounded cursor-pointer transition-colors ${
                                    t.excluded
                                      ? 'bg-danger/5 opacity-50 line-through text-[var(--text-muted)]'
                                      : 'hover:bg-[var(--bg-subtle)] text-[var(--text-main)]'
                                  }`}
                                >
                                  <div className="flex items-center gap-2 truncate">
                                    {t.excluded ? (
                                      <Square className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                                    ) : (
                                      <CheckSquare className="w-3.5 h-3.5 text-success shrink-0" />
                                    )}
                                    <span
                                      className={`text-xs px-1.5 py-0.2 rounded font-mono font-bold uppercase shrink-0 ${
                                        t.stage === 'done'
                                          ? 'bg-success/20 text-success'
                                          : t.stage === 'in_progress'
                                          ? 'bg-warning/20 text-warning'
                                          : t.stage === 'blocked'
                                          ? 'bg-danger/20 text-danger'
                                          : 'bg-info/20 text-info'
                                      }`}
                                    >
                                      {t.stage}
                                    </span>
                                    <span className="truncate">{t.title}</span>
                                  </div>

                                  <span className="font-mono text-xs text-[var(--text-muted)] shrink-0">
                                    {formatDurationSeconds(t.elapsedSeconds)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Modal Footer / Commit Actions */}
        {embedded ? (
          <div className="pt-3 border-t border-[var(--border-app)] flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isSubmitting || isLoading || !!errorMsg || selectedLogIds.size === 0}
              className="v2-btn v2-btn-strong inline-flex items-center gap-2 min-h-11 px-4 cursor-pointer disabled:opacity-50 disabled:cursor-default"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              <span>
                {isSubmitting ? 'Adding…' : `Add ${selectedLogIds.size} ${selectedLogIds.size === 1 ? 'log' : 'logs'}`}
              </span>
            </button>
          </div>
        ) : (
        <div className="p-4 sm:p-5 border-t border-[var(--border-app)] bg-[var(--bg-subtle)]/50 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-[var(--text-muted)] font-mono">
            {hasGoogleSheetLinked ? (
              <span className="text-success font-semibold flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Google Sheet endpoint linked & ready</span>
              </span>
            ) : (
              <span className="text-warning flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Offline mode (logs will be recorded to local timeline)</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-semibold rounded-[var(--radius-btn)] border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--text-main)] hover:bg-[var(--bg-subtle)] cursor-pointer"
            >
              Cancel
            </button>
            )}

            <button
              type="button"
              onClick={handleConfirm}
              disabled={isSubmitting || isLoading || !!errorMsg || selectedLogIds.size === 0}
              className="px-5 py-2 text-xs font-bold rounded-[var(--radius-btn)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] disabled:opacity-40 disabled:pointer-events-none transition-all flex items-center gap-2 cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Pushing to Google Sheet...</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Push {selectedLogIds.size} to the Sheet</span>
                </>
              )}
            </button>
          </div>
        </div>
        )}
      </>
  );
};
