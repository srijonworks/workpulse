import React, { useEffect, useId, useRef, useState } from 'react';
import { DatePicker } from '../ui/DatePicker';
import { Select } from '../ui/Select';
import { X } from 'lucide-react';
import { ModalShell } from '../ui/ModalShell';
import { IconButton } from '../ui/IconButton';
import { SWATCHES, Swatches } from './ProjectSwatches';
import type { Project, TaskStatus, WorkLog } from '../../types';
import { activeProjectsOf, defaultProject } from '../../utils/projects';
import { localDateStr, localTimeStr } from '../../utils/dates';
import { minutesFromSeconds } from '../../utils/duration';
import { formatMinutes } from '../../utils/activity/time';

export interface LogFormPrefill {
  description: string;
  projectId: string;
  status?: TaskStatus;
  /** Called after the new log is saved (not on Cancel), e.g. to clear the quick-log text it came from. */
  onSaved?(): void;
}

export interface LogFormDialogProps {
  isOpen: boolean;
  projects: Project[];
  tags: string[];
  /** The log being edited, or null for a new log. */
  editing: WorkLog | null;
  /** Starting values for a new log (quick log "Details"). Ignored while editing. */
  prefill: LogFormPrefill | null;
  /** `id` is the edited log's id; absent for a new log. */
  onSave(data: Omit<WorkLog, 'id' | 'createdAt'>, id?: string): void;
  onAddProject(name: string, color: string): void;
  onClose(): void;
}

const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: 'completed', label: 'Done' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
];

const NEW_PROJECT = '__new__';

const FIELD =
  'w-full min-h-10 px-3 py-2 rounded-[var(--radius-btn)] border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--text-main)] text-[length:var(--fs-body)] focus:border-[var(--border-focus)]';
const LABEL = 'block mb-1.5 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]';

export const LogFormDialog: React.FC<LogFormDialogProps> = ({ isOpen, ...rest }) => (isOpen ? <LogForm {...rest} /> : null);

// Mounted fresh on every open, so the fields start from `editing`, `prefill` or today/now.
const LogForm: React.FC<Omit<LogFormDialogProps, 'isOpen'>> = ({ projects, tags, editing, prefill, onSave, onAddProject, onClose }) => {
  const id = useId();
  const titleId = `${id}-title`;
  const start = editing ?? null;
  const initialProjectId = start?.projectId ?? (prefill?.projectId || defaultProject(projects)?.id || '');

  const [description, setDescription] = useState(start?.description ?? prefill?.description ?? '');
  const [projectId, setProjectId] = useState(initialProjectId);
  const [status, setStatus] = useState<TaskStatus>(start?.status ?? prefill?.status ?? 'completed');
  const [minutes, setMinutes] = useState(start?.durationMinutes ? String(start.durationMinutes) : '');
  const [chosenTags, setChosenTags] = useState<string[]>(start?.tags ?? []);
  const [linkUrl, setLinkUrl] = useState(start?.linkUrl ?? '');
  const [date, setDate] = useState(start?.date ?? localDateStr());
  const [time, setTime] = useState(start?.time ?? localTimeStr());
  const [error, setError] = useState('');

  const [addingProject, setAddingProject] = useState(false);
  const [newName, setNewName] = useState('');
  // The first of the eight colours no project uses yet.
  const [newColor, setNewColor] = useState(
    () => (SWATCHES.find((s) => !projects.some((p) => p.color.toLowerCase() === s.hex)) ?? SWATCHES[0]).hex,
  );
  const [pendingName, setPendingName] = useState('');
  const descRef = useRef<HTMLTextAreaElement>(null);

  // A project added from here is picked as soon as it exists (onAddProject does not return its id).
  useEffect(() => {
    if (!pendingName) return;
    const made = [...projects].reverse().find((p) => p.name === pendingName && !p.isArchived);
    if (made) {
      setProjectId(made.id);
      setPendingName('');
    }
  }, [projects, pendingName]);

  const active = activeProjectsOf(projects);
  const current = projects.find((p) => p.id === projectId);
  // The edited log's project may be archived or deleted: keep it selectable under its saved name.
  const keepOld = projectId && !active.some((p) => p.id === projectId);

  const save = () => {
    const text = description.trim();
    if (!text) {
      setError('Write what you did first.');
      descRef.current?.focus();
      return;
    }
    const mins = Math.round(Number(minutes));
    const data: Omit<WorkLog, 'id' | 'createdAt'> = {
      date: date || localDateStr(),
      time: time || localTimeStr(),
      projectId: current?.id ?? (projectId || 'default'),
      projectName: current?.name ?? editing?.projectName ?? 'General',
      description: text,
      status,
      tags: chosenTags,
      linkUrl: linkUrl.trim() || undefined,
      durationMinutes: mins > 0 ? mins : undefined,
      // Fields this form does not show are kept as they were.
      energyRating: editing?.energyRating,
      imageBase64: editing?.imageBase64,
    };
    onSave(data, editing?.id);
    if (!editing) prefill?.onSaved?.();
    onClose();
  };

  const addProject = () => {
    const name = newName.trim();
    if (!name) return;
    onAddProject(name, newColor);
    setPendingName(name);
    setAddingProject(false);
    setNewName('');
  };

  const subtasks = editing?.underlyingTasks ?? [];

  return (
    <ModalShell
      onClose={onClose}
      labelledBy={titleId}
      backdropClassName="p-3 sm:p-6 overflow-y-auto"
      className="w-full max-w-xl my-auto bg-[var(--bg-surface-elevated)] text-[var(--text-main)] border border-[var(--border-app)] rounded-[var(--radius-card)]"
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
      >
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 pt-5">
          <h2 id={titleId} className="text-[length:var(--fs-body)] font-bold">
            {editing ? 'Edit log' : 'New log'}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="w-5 h-5" aria-hidden="true" />
          </IconButton>
        </div>

        <div className="px-5 sm:px-6 py-4 space-y-4">
          <div>
            <label htmlFor={`${id}-desc`} className={LABEL}>
              What did you do?
            </label>
            <textarea
              id={`${id}-desc`}
              ref={descRef}
              data-autofocus
              aria-required="true"
              rows={3}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                if (error) setError('');
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-err` : undefined}
              className={`${FIELD} resize-y`}
            />
            {error && (
              <p id={`${id}-err`} role="alert" className="mt-1.5 text-[length:var(--fs-small)] font-semibold text-danger">
                {error}
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-project`} className={LABEL}>
                Project
              </label>
              <Select
                id={`${id}-project`}
                value={projectId}
                onChange={(v) => {
                  if (v === NEW_PROJECT) setAddingProject(true);
                  else setProjectId(v);
                }}
                options={[
                  ...(keepOld ? [{ value: projectId, label: current?.name ?? editing?.projectName ?? 'General' }] : []),
                  ...(!projectId ? [{ value: '', label: 'General' }] : []),
                  ...active.map((p) => ({ value: p.id, label: p.name })),
                  { value: NEW_PROJECT, label: 'New project…' },
                ]}
              />
            </div>
            <div>
              <label htmlFor={`${id}-mins`} className={LABEL}>
                Duration in minutes
              </label>
              <input
                id={`${id}-mins`}
                type="number"
                min={0}
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="Leave empty if not timed"
                className={`num ${FIELD}`}
              />
            </div>
          </div>

          {addingProject && (
            <div className="p-3 rounded-[var(--radius-btn)] border border-[var(--border-app)] bg-[var(--bg-subtle)] space-y-2">
              <label htmlFor={`${id}-newname`} className={LABEL}>
                New project name
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id={`${id}-newname`}
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addProject();
                    }
                    // Escape cancels only this row, not the whole form.
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setAddingProject(false);
                    }
                  }}
                  className={`${FIELD} flex-1 min-w-40 w-auto`}
                />
                <button type="button" onClick={addProject} disabled={!newName.trim()} className="v2-btn v2-btn-strong min-h-10 px-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                  Add project
                </button>
                <button type="button" onClick={() => setAddingProject(false)} className="v2-btn min-h-10 px-4 cursor-pointer">
                  Cancel
                </button>
              </div>
              <Swatches value={newColor} label="Project colour" onPick={setNewColor} />
            </div>
          )}

          <fieldset>
            <legend className={LABEL}>Status</legend>
            <div className="inline-flex flex-wrap rounded-[var(--radius-btn)] border border-[var(--border-control)] overflow-hidden">
              {STATUSES.map((s) => (
                <label key={s.value} className="relative cursor-pointer">
                  <input
                    type="radio"
                    name={`${id}-status`}
                    value={s.value}
                    checked={status === s.value}
                    onChange={() => setStatus(s.value)}
                    className="peer sr-only"
                  />
                  <span className="flex items-center min-h-10 px-4 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)] hover:bg-[var(--bg-subtle)] peer-checked:bg-[var(--text-main)] peer-checked:text-[var(--bg-surface)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[-4px] peer-focus-visible:outline-[var(--accent-text)] peer-checked:peer-focus-visible:outline-[var(--bg-surface)]">
                    {s.label}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {tags.length > 0 && (
            <fieldset>
              <legend className={LABEL}>Tags</legend>
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => {
                  const on = chosenTags.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setChosenTags((prev) => (on ? prev.filter((x) => x !== t) : [...prev, t]))}
                      className={`min-h-8 pointer-coarse:min-h-11 px-3 rounded-[var(--radius-btn)] border text-[length:var(--fs-small)] font-medium cursor-pointer transition-colors ${
                        on
                          ? 'bg-[var(--text-main)] border-[var(--text-main)] text-[var(--bg-surface)]'
                          : 'border-[var(--border-control)] text-[var(--text-main)] hover:bg-[var(--bg-subtle)]'
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          <div>
            <label htmlFor={`${id}-link`} className={LABEL}>
              Link (optional)
            </label>
            <input
              id={`${id}-link`}
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://"
              className={FIELD}
            />
          </div>

          <div className="grid gap-4 grid-cols-2">
            <div>
              <label htmlFor={`${id}-date`} className={LABEL}>
                Date
              </label>
              <DatePicker id={`${id}-date`} value={date} onChange={(v) => v && setDate(v)} />
            </div>
            <div>
              <label htmlFor={`${id}-time`} className={LABEL}>
                Time
              </label>
              <input id={`${id}-time`} type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`num ${FIELD}`} />
            </div>
          </div>

          {subtasks.length > 0 && (
            <div>
              <h3 className={LABEL}>Sub-tasks in this log</h3>
              <ul className="border-t border-[var(--border-app)]">
                {subtasks.map((t) => {
                  const m = minutesFromSeconds(t.elapsedSeconds);
                  return (
                    <li key={t.id} className="flex items-baseline justify-between gap-3 py-2 border-b border-[var(--border-app)] text-[length:var(--fs-small)]">
                      <span className="text-[var(--text-main)] break-words">{t.title}</span>
                      {m > 0 && <span className="num shrink-0 text-[var(--text-muted)]">{formatMinutes(m)}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-t border-[var(--border-app)]">
          <span className="text-[length:var(--fs-small)] text-[var(--text-muted)] max-sm:hidden">Ctrl+Enter saves</span>
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={onClose} className="v2-btn min-h-10 px-4 cursor-pointer">
              Cancel
            </button>
            <button
              type="submit"
              className="min-h-10 px-5 rounded-[var(--radius-btn)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] text-[length:var(--fs-small)] font-bold cursor-pointer transition-colors"
            >
              {editing ? 'Save changes' : 'Add log'}
            </button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
};
