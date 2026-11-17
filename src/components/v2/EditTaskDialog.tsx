import React, { useId, useState } from 'react';
import { DatePicker } from '../ui/DatePicker';
import { Select } from '../ui/Select';
import { ModalShell } from '../ui/ModalShell';
import type { BacklogTask, Project } from '../../types';

interface Props {
  task: BacklogTask;
  /** Projects to pick from (not trashed). */
  projects: Project[];
  onClose(): void;
  onSave(id: string, changes: { title: string; projectId: string; dueDate: string }): void;
}

const FIELD =
  'h-10 px-3 w-full rounded-[var(--radius-btn)] border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--text-main)] text-[length:var(--fs-body)] focus:border-[var(--border-focus)]';
const LABEL = 'block mb-1.5 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]';

/** Change a task's title, project or date. Timer, stage and logged time are left alone. */
export const EditTaskDialog: React.FC<Props> = ({ task, projects, onClose, onSave }) => {
  const id = useId();
  const [title, setTitle] = useState(task.title);
  const [projectId, setProjectId] = useState(task.projectId);
  const [dueDate, setDueDate] = useState(task.dueDate);
  // A project the task already has stays listed even if it is archived.
  const options = projects.filter((p) => !p.isArchived || p.id === task.projectId);
  const ok = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(dueDate);

  const save = () => {
    if (ok) onSave(task.id, { title: title.trim(), projectId, dueDate });
  };

  return (
    <ModalShell
      onClose={onClose}
      labelledBy={`${id}-t`}
      closeOnBackdrop
      className="w-full max-w-md p-6 bg-[var(--bg-surface-elevated)] text-[var(--text-main)] border border-[var(--border-app)] rounded-[var(--radius-card)]"
    >
      <h2 id={`${id}-t`} className="text-[length:var(--fs-body)] font-bold">
        Edit task
      </h2>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div>
          <label htmlFor={`${id}-title`} className={LABEL}>
            Title
          </label>
          <input id={`${id}-title`} data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
        </div>
        <div>
          <label htmlFor={`${id}-project`} className={LABEL}>
            Project
          </label>
          <Select
            id={`${id}-project`}
            value={projectId}
            onChange={setProjectId}
            options={[...(options.some((p) => p.id === projectId) ? [] : [{ value: projectId, label: 'No project' }]), ...options.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </div>
        <div>
          <label htmlFor={`${id}-date`} className={LABEL}>
            Date
          </label>
          <DatePicker id={`${id}-date`} value={dueDate} onChange={(v) => v && setDueDate(v)} />
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-3 rounded-[var(--radius-btn)] text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-subtle)] cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ok}
            className="h-10 px-5 rounded-[var(--radius-btn)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)] text-[length:var(--fs-body)] font-bold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </form>
    </ModalShell>
  );
};
