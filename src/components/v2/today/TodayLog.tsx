import React, { useId, useMemo, useState } from 'react';
import type { Project, WorkLog } from '../../../types';
import { LogRow, formatMinutes } from './LogRow';
import { SyncButton, type SyncState } from '../SyncButton';
import type { LogFormPrefill } from '../LogFormDialog';
import { localTimeStr } from '../../../utils/dates';
import { splitProjectTag } from '../../../utils/projects';
import { ProjectInput, useProjectChoice } from '../ProjectInput';

export interface TodayLogProps {
  logs: WorkLog[];
  projects: Project[];
  today: string;
  onAddLog(data: Omit<WorkLog, 'id' | 'createdAt'>): void;
  onOpenLogForm(prefill: LogFormPrefill | null): void;
  onEditLog(log: WorkLog): void;
  onDeleteLog(id: string): void;
  onDuplicateLog(log: WorkLog): void;
  /** Absent once today is clocked out: there is no day left to end (the band offers Resume). */
  onEndDay?(): void;
  /** Opens the Standup dialog with today's logs selected. */
  onStandup(): void;
  onOpenImage(base64: string): void;
  sync: SyncState;
  /** The project last used from the quick inputs (the selector's starting point). */
  lastProjectId?: string;
  /** Remembers the project a log was just added to. */
  onProjectUsed(id: string): void;
  /** Creates a project from a `#word` with no match and returns it. */
  onCreateProject(name: string, color: string): Project;
}

export const TodayLog: React.FC<TodayLogProps> = ({ logs, projects, today, onAddLog, onOpenLogForm, onEditLog, onDeleteLog, onDuplicateLog, onEndDay, onStandup, onOpenImage, sync, lastProjectId, onProjectUsed, onCreateProject }) => {
  const id = useId();
  const [draft, setDraft] = useState('');
  const todays = useMemo(
    () => logs.filter((l) => l.date === today).sort((a, b) => b.time.localeCompare(a.time) || b.createdAt.localeCompare(a.createdAt)),
    [logs, today],
  );
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const total = todays.reduce((sum, l) => sum + (l.durationMinutes ?? 0), 0);

  const { project: selected, setProjectId } = useProjectChoice(projects, lastProjectId);
  // A matched "#word" left in the text (pasted, or the list was closed with Escape) still picks its project.
  const parsed = splitProjectTag(draft, projects);
  const target = parsed.project ?? selected;

  const logNow = () => {
    const text = parsed.text.trim();
    if (!text) return;
    onAddLog({
      date: today,
      time: localTimeStr(),
      projectId: target?.id ?? 'default',
      projectName: target?.name ?? 'General',
      description: text,
      status: 'completed',
      tags: [],
    });
    if (target) onProjectUsed(target.id);
    setDraft('');
  };

  const openDetails = () => {
    const text = parsed.text.trim();
    // The text stays in the quick log until the dialog saves it, so Cancel loses nothing.
    onOpenLogForm(
      text || parsed.project
        ? { description: text, projectId: target?.id ?? '', status: 'completed', onSaved: () => setDraft('') }
        : null,
    );
  };

  return (
    <section aria-labelledby={`${id}-h`}>
      <div className="v2-head v2-head-split">
        <h2 id={`${id}-h`} className="v2-head-group">
          <span>Today's log</span>
          <span className="v2-head-meta num">
            {todays.length} {todays.length === 1 ? 'entry' : 'entries'} · {formatMinutes(total)}
            <span className="sr-only"> logged</span>
          </span>
        </h2>
        {onEndDay && (
          <button
            type="button"
            onClick={onEndDay}
            className="v2-btn v2-btn-strong w-full sm:w-auto min-h-9 pointer-coarse:min-h-11 px-4 normal-case tracking-normal cursor-pointer transition-colors"
          >
            End my day
          </button>
        )}
      </div>
      <div className="v2-panel">
        <div className="v2-row v2-inset">
          <ProjectInput
            id={`${id}-add`}
            label="What did you just finish?"
            value={draft}
            onChange={setDraft}
            projects={projects}
            project={selected}
            onProjectChange={setProjectId}
            onCreateProject={onCreateProject}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                logNow();
              }
            }}
            placeholder="What did you just finish?"
            describedBy={`${id}-hint`}
            trailing={
              <button type="button" onClick={openDetails} className="v2-btn shrink-0 h-11 px-4 cursor-pointer transition-colors">
                Details
              </button>
            }
          />
          <p id={`${id}-hint`} aria-live="polite" className="mt-1.5 text-[length:var(--fs-small)] text-[var(--text-muted)]">
            {draft.trim() ? `Enter logs it to ${target?.name ?? 'General'}.` : 'Enter logs it. Type # to pick a project.'}
          </p>
        </div>
        {todays.length === 0 ? (
          <p className="v2-row v2-inset text-[length:var(--fs-body)] text-[var(--text-muted)]">No logs today. Finished something? Write one line above.</p>
        ) : (
          <ul>
            {todays.map((l) => (
              <LogRow
                key={l.id}
                log={l}
                project={byId.get(l.projectId)}
                onEdit={onEditLog}
                onDuplicate={onDuplicateLog}
                onDelete={onDeleteLog}
                onOpenImage={onOpenImage}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <SyncButton {...sync} />
        {todays.length > 0 && (
          <button type="button" onClick={onStandup} className="v2-btn min-h-11 px-4 cursor-pointer transition-colors">
            Standup
          </button>
        )}
      </div>
    </section>
  );
};
