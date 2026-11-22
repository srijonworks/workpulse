import React from 'react';
import type { BacklogTask, Project, TaskStage, WorkLog } from '../../../types';
import type { LogFormPrefill } from '../LogFormDialog';
import type { SuggestionsCardProps } from './SuggestionsCard';
import { SuggestionsCard } from './SuggestionsCard';
import { TodayTasks } from './TodayTasks';
import { TodayLog } from './TodayLog';
import { sameTasksIgnoringLiveTime } from '../../../utils/timerStore';
import type { SyncState } from '../SyncButton';

/** What the suggestions card needs besides the logs, tasks and projects the screen already has. */
export type TodayActivityProps = Pick<SuggestionsCardProps, 'folders' | 'sources' | 'ai' | 'autoScan' | 'geminiApiKey' | 'onAddLogs' | 'onOpenSettings'>;

export interface TodayScreenProps {
  backlog: BacklogTask[];
  logs: WorkLog[];
  projects: Project[];
  /** Local YYYY-MM-DD. */
  today: string;
  onAddTask(title: string, projectId: string, stage: TaskStage): void;
  onStage(id: string, stage: TaskStage, reason?: string): void;
  onComplete(task: BacklogTask): void;
  onLogTask(task: BacklogTask): void;
  /** Reopens a done task into planned ("Back to planned"). */
  onReopen(id: string): void;
  onDeleteTask(id: string): void;
  onEditTask?(task: BacklogTask): void;
  onAdjustTime?(task: BacklogTask): void;
  /** Sets the due date of the given pending tasks to today. */
  onMoveToToday(ids: string[]): void;
  /** Opens Plan your day. */
  onPlanDay(): void;
  /** Switches to the Tasks page. */
  onOpenTasks(): void;
  onAddLog(data: Omit<WorkLog, 'id' | 'createdAt'>): void;
  /** Opens LogFormDialog for a new log, with the quick-log text as a starting point (or empty). */
  onOpenLogForm(prefill: LogFormPrefill | null): void;
  onEditLog(log: WorkLog): void;
  onDeleteLog(id: string): void;
  onDuplicateLog(log: WorkLog): void;
  activityProps: TodayActivityProps;
  onSuggestionsPending(n: number): void;
  onActivityScanned(): void;
  onEndDay?(): void;
  onStandup(): void;
  onOpenImage(base64: string): void;
  /** The Sync button's state (App memoizes it, so the memo below holds). */
  sync: SyncState;
  /** The project last used from the quick inputs. */
  lastProjectId?: string;
  onProjectUsed(id: string): void;
  onCreateProject(name: string, color: string): Project;
}

const TodayScreenView: React.FC<TodayScreenProps> = ({
  backlog,
  logs,
  projects,
  today,
  onAddTask,
  onStage,
  onComplete,
  onLogTask,
  onReopen,
  onDeleteTask,
  onEditTask,
  onAdjustTime,
  onMoveToToday,
  onPlanDay,
  onOpenTasks,
  onAddLog,
  onOpenLogForm,
  onEditLog,
  onDeleteLog,
  onDuplicateLog,
  activityProps,
  onSuggestionsPending,
  onActivityScanned,
  onEndDay,
  onStandup,
  onOpenImage,
  sync,
  lastProjectId,
  onProjectUsed,
  onCreateProject,
}) => (
  // Desktop: tasks on the left (7/12), suggestions over the log on the right (5/12).
  // Under 1024 px one column: tasks, log, suggestions.
  <div className="mx-auto max-w-[1440px] px-4 sm:px-8 py-6 sm:py-7 grid gap-7 lg:grid-cols-12 lg:grid-rows-[auto_1fr]">
    <div className="order-1 lg:order-none lg:col-span-7 lg:row-span-2 min-w-0">
      <TodayTasks
        backlog={backlog}
        projects={projects}
        today={today}
        onAddTask={onAddTask}
        onStage={onStage}
        onComplete={onComplete}
        onLogTask={onLogTask}
        onReopen={onReopen}
        onDeleteTask={onDeleteTask}
        onEditTask={onEditTask}
        onAdjustTime={onAdjustTime}
        onMoveToToday={onMoveToToday}
        onPlanDay={onPlanDay}
        onOpenTasks={onOpenTasks}
        lastProjectId={lastProjectId}
        onProjectUsed={onProjectUsed}
        onCreateProject={onCreateProject}
      />
    </div>
    <div className="order-3 lg:order-none lg:col-span-5 min-w-0">
      <SuggestionsCard
        {...activityProps}
        date={today}
        logs={logs}
        backlog={backlog}
        projects={projects}
        onPendingChange={onSuggestionsPending}
        onScanned={onActivityScanned}
      />
    </div>
    <div className="order-2 lg:order-none lg:col-span-5 min-w-0 lg:self-start">
      <TodayLog
        logs={logs}
        projects={projects}
        today={today}
        onAddLog={onAddLog}
        onOpenLogForm={onOpenLogForm}
        onEditLog={onEditLog}
        onDeleteLog={onDeleteLog}
        onDuplicateLog={onDuplicateLog}
        onEndDay={onEndDay}
        onStandup={onStandup}
        onOpenImage={onOpenImage}
        sync={sync}
        lastProjectId={lastProjectId}
        onProjectUsed={onProjectUsed}
        onCreateProject={onCreateProject}
      />
    </div>
  </div>
);

// activityProps is compared field by field, so App may build it inline, along with `sources`
// (two flags) and an empty `folders` fallback. Its functions must be stable (useStableCallback).
export const sameActivityProps = (a: TodayActivityProps, b: TodayActivityProps): boolean =>
  a === b ||
  (a.ai === b.ai &&
    a.autoScan === b.autoScan &&
    a.geminiApiKey === b.geminiApiKey &&
    a.onAddLogs === b.onAddLogs &&
    a.onOpenSettings === b.onOpenSettings &&
    a.sources.git === b.sources.git &&
    a.sources.claude === b.sources.claude &&
    (a.folders === b.folders || (a.folders.length === 0 && b.folders.length === 0)));

// Redraws only when something it shows changes: the running clocks tick on their own (<TaskClock>),
// so a backlog that differs only in running tasks' elapsed seconds is "the same".
const sameTodayProps = (prev: TodayScreenProps, next: TodayScreenProps): boolean =>
  (Object.keys(next) as (keyof TodayScreenProps)[]).every((k) => {
    if (k === 'backlog') return sameTasksIgnoringLiveTime(prev.backlog, next.backlog);
    if (k === 'activityProps') return sameActivityProps(prev.activityProps, next.activityProps);
    return prev[k] === next[k];
  });

export const TodayScreen = React.memo(TodayScreenView, sameTodayProps);
