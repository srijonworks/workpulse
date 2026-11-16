import React, { useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, Loader2, Plus, X } from 'lucide-react';
import type { BacklogTask, Project, WorkLog } from '../../../types';
import type { ActivityFolder } from '../../../utils/activity/types';
import { isFullFolderPath } from '../../../utils/activity/settings';
import { pickFolder } from '../../../utils/pickFolderClient';
import { folderProjectName, foldersOfProject } from '../../../utils/projectFromFolder';
import { projectUse, shortFolder, trashedProjectsOf } from '../../../utils/projects';
import { IconButton } from '../../ui/IconButton';
import { ModalShell } from '../../ui/ModalShell';
import { SWATCHES, Swatches } from '../ProjectSwatches';

export type ActionResult = { ok: boolean; message: string };

interface ProjectsSectionProps {
  /** Every project, trashed ones included. */
  projects: Project[];
  tags: string[];
  folders: ActivityFolder[];
  logs: WorkLog[];
  backlog: BacklogTask[];
  onUpdateProjects(p: Project[]): void;
  onUpdateTags(t: string[]): void;
  onAddProjectWithFolder(input: { name?: string; color?: string; path?: string }): ActionResult;
  onSetProjectFolder(projectId: string, oldPath: string | undefined, newPath: string): ActionResult;
  onRemoveProjectFolder(path: string): void;
  onTrashProject(id: string): void;
  onRestoreProject(id: string): void;
  onDeleteProjectForever(id: string): void;
}

const LABEL = 'block mb-1 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]';
const FIELD = 'v2-input w-full h-11 px-3 text-[length:var(--fs-body)]';
const BTN = 'v2-btn inline-flex items-center justify-center gap-1.5 min-h-11 px-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
const TEXT_BTN =
  'min-h-8 pointer-coarse:min-h-11 px-1 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] underline underline-offset-4 cursor-pointer disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed';
const NOTE = 'text-[length:var(--fs-small)] text-[var(--text-muted)]';

/** A folder path box with a "Choose folder" button (the folder window on this computer; typing works too). */
const FolderField: React.FC<{
  id: string;
  label: string;
  path: string;
  onPath(path: string): void;
  onPicked?(path: string): void;
}> = ({ id, label, path, onPath, onPicked }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const choose = async () => {
    setBusy(true);
    setError('');
    const picked = await pickFolder();
    setBusy(false);
    if (picked.kind === 'cancelled') return;
    if (picked.kind === 'error') return setError(picked.message);
    onPath(picked.path);
    onPicked?.(picked.path);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor={id} className={LABEL}>
            {label}
          </label>
          <input
            id={id}
            type="text"
            value={path}
            onChange={(e) => {
              onPath(e.target.value);
              setError('');
            }}
            placeholder="E:\projects\app"
            autoComplete="off"
            spellCheck={false}
            className={FIELD}
          />
        </div>
        <button type="button" onClick={choose} disabled={busy} className={BTN}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FolderOpen className="h-4 w-4" aria-hidden="true" />}
          Choose folder
        </button>
      </div>
      {busy && <p className={NOTE}>Choose the folder in the window that opened.</p>}
      {error && (
        <p role="status" className={NOTE}>
          {error}
        </p>
      )}
    </div>
  );
};

interface ProjectRowProps {
  project: Project;
  folders: ActivityFolder[];
  canHide: boolean;
  onRename(name: string): void;
  onColor(hex: string): void;
  onToggleArchive(): void;
  onTrash(): void;
  onSetFolder(oldPath: string | undefined, newPath: string): ActionResult;
  onRemoveFolder(path: string): void;
}

const ProjectRow: React.FC<ProjectRowProps> = ({
  project,
  folders,
  canHide,
  onRename,
  onColor,
  onToggleArchive,
  onTrash,
  onSetFolder,
  onRemoveFolder,
}) => {
  const id = useId();
  const [draft, setDraft] = useState(project.name);
  const [picking, setPicking] = useState(false);
  // null: not editing a folder; `old` is the path being changed, absent for "Add folder"
  const [editing, setEditing] = useState<{ old?: string } | null>(null);
  const [folderDraft, setFolderDraft] = useState('');
  const [note, setNote] = useState('');
  const cancelled = useRef(false);

  useEffect(() => setDraft(project.name), [project.name]);

  const commit = () => {
    const name = draft.trim();
    if (cancelled.current || !name) setDraft(project.name);
    else if (name !== project.name) onRename(name);
    else setDraft(project.name);
    cancelled.current = false;
  };

  const startEditing = (old?: string) => {
    setEditing({ old });
    setFolderDraft('');
    setNote('');
  };

  const saveFolder = () => {
    const path = folderDraft.trim();
    if (!path) return;
    if (!isFullFolderPath(path)) return setNote('Enter the full folder path, like E:\\projects\\app.');
    const res = onSetFolder(editing?.old, path);
    if (res.ok) {
      setEditing(null);
      setNote('');
    } else setNote(res.message);
  };

  return (
    <li className="v2-row v2-inset">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <IconButton
          label={`Change colour of ${project.name}`}
          aria-expanded={picking}
          onClick={() => setPicking((p) => !p)}
        >
          <span
            className="block h-5 w-5 rounded-[var(--radius-btn)] border border-[var(--border-control)]"
            style={{ backgroundColor: project.color }}
          />
        </IconButton>
        <input
          type="text"
          value={draft}
          aria-label={`Name of ${project.name}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
          className={`min-h-11 min-w-0 flex-1 basis-40 rounded-[var(--radius-btn)] border border-transparent bg-transparent px-2 text-[length:var(--fs-body)] font-semibold hover:border-[var(--border-app)] focus:border-[var(--border-focus)] ${
            project.isArchived ? 'text-[var(--text-muted)]' : 'text-[var(--text-main)]'
          }`}
        />
        {project.isArchived && <span className={NOTE}>Archived</span>}
        <button
          type="button"
          onClick={onToggleArchive}
          disabled={!project.isArchived && !canHide}
          aria-label={`${project.isArchived ? 'Unarchive' : 'Archive'} ${project.name}`}
          className={TEXT_BTN}
        >
          {project.isArchived ? 'Unarchive' : 'Archive'}
        </button>
        <button
          type="button"
          onClick={onTrash}
          disabled={!project.isArchived && !canHide}
          aria-label={`Move ${project.name} to the Trash`}
          className={TEXT_BTN}
        >
          Move to trash
        </button>
      </div>
      {picking && (
        <div className="pt-2 pl-1">
          <Swatches value={project.color} label={`Colour of ${project.name}`} onPick={onColor} />
        </div>
      )}

      <div className="flex flex-col gap-1 pt-1 pl-1">
        {folders.length === 0 && !editing && <p className={NOTE}>No folder linked.</p>}
        {folders.map((f) => (
          <div key={f.path} className="flex flex-wrap items-center gap-x-3">
            <span className="min-w-0 truncate font-mono text-[length:var(--fs-small)] text-[var(--text-main)]" title={f.path}>
              {shortFolder(f.path)}
            </span>
            <button type="button" onClick={() => startEditing(f.path)} aria-label={`Change folder ${f.path}`} className={TEXT_BTN}>
              Change
            </button>
            <button type="button" onClick={() => onRemoveFolder(f.path)} aria-label={`Remove link to ${f.path}`} className={TEXT_BTN}>
              Remove link
            </button>
          </div>
        ))}
        {!editing && (
          <div>
            <button type="button" onClick={() => startEditing(undefined)} aria-label={`Add folder to ${project.name}`} className={TEXT_BTN}>
              Add folder
            </button>
          </div>
        )}
        {editing && (
          <div className="flex flex-col gap-2 pt-1">
            <FolderField
              id={`${id}-folder`}
              label={editing.old ? 'New folder' : 'Folder'}
              path={folderDraft}
              onPath={(p) => {
                setFolderDraft(p);
                setNote('');
              }}
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={saveFolder} disabled={!folderDraft.trim()} className={`${BTN} v2-btn-strong`}>
                Link folder
              </button>
              <button type="button" onClick={() => setEditing(null)} className={BTN}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {note && (
          <p role="status" className={NOTE}>
            {note}
          </p>
        )}
      </div>
    </li>
  );
};

/** "Delete forever" asks first and says how much work still points at the project. */
const DeleteForeverDialog: React.FC<{
  project: Project;
  use: { tasks: number; logs: number };
  onCancel(): void;
  onConfirm(): void;
}> = ({ project, use, onCancel, onConfirm }) => {
  const id = useId();
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    <ModalShell
      onClose={onCancel}
      labelledBy={`${id}-title`}
      closeOnBackdrop
      className="w-full max-w-sm p-6 bg-[var(--bg-surface-elevated)] text-[var(--text-main)] border border-[var(--border-app)] rounded-[var(--radius-card)]"
    >
      <h2 id={`${id}-title`} className="text-[length:var(--fs-body)] font-bold">
        Delete &quot;{project.name}&quot; for good?
      </h2>
      <p className="mt-2 text-[length:var(--fs-small)] text-[var(--text-muted)]">
        {use.tasks + use.logs === 0
          ? 'No tasks or logs use it.'
          : `${plural(use.tasks, 'task')} and ${plural(use.logs, 'log')} use it. They stay, and show "No project" where a project is needed.`}{' '}
        Its folder links are removed. This cannot be undone.
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" data-autofocus onClick={onCancel} className={BTN}>
          Keep it in the Trash
        </button>
        <button type="button" onClick={onConfirm} className={`${BTN} v2-btn-strong`}>
          Delete forever
        </button>
      </div>
    </ModalShell>
  );
};

export const ProjectsSection: React.FC<ProjectsSectionProps> = ({
  projects,
  tags,
  folders,
  logs,
  backlog,
  onUpdateProjects,
  onUpdateTags,
  onAddProjectWithFolder,
  onSetProjectFolder,
  onRemoveProjectFolder,
  onTrashProject,
  onRestoreProject,
  onDeleteProjectForever,
}) => {
  const id = useId();
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(SWATCHES[0].hex);
  const [newPath, setNewPath] = useState('');
  const [note, setNote] = useState<ActionResult | null>(null);
  const [newTag, setNewTag] = useState('');
  const [deleting, setDeleting] = useState<Project | null>(null);

  const listed = projects.filter((p) => !p.trashedAt);
  const trashed = trashedProjectsOf(projects);
  const activeCount = listed.filter((p) => !p.isArchived).length;

  const patch = (pid: string, change: Partial<Project>) =>
    onUpdateProjects(projects.map((p) => (p.id === pid ? { ...p, ...change } : p)));

  const addProject = (e: React.FormEvent) => {
    e.preventDefault();
    const path = newPath.trim();
    if (!newName.trim() && !path) return;
    if (path && !isFullFolderPath(path)) return setNote({ ok: false, message: 'Enter the full folder path, like E:\\projects\\app.' });
    const res = onAddProjectWithFolder({ name: newName, color: newColor, path: path || undefined });
    setNote(res);
    if (!res.ok) return;
    setNewName('');
    setNewPath('');
    // Move on to the next colour so two new projects do not start out alike.
    const i = SWATCHES.findIndex((s) => s.hex === newColor);
    setNewColor(SWATCHES[(i + 1) % SWATCHES.length].hex);
  };

  // A folder fills the name when it is empty ("C:\work\HMIS" -> "HMIS").
  const folderChosen = (path: string) => {
    setNote(null);
    if (!newName.trim() && isFullFolderPath(path)) setNewName(folderProjectName(path));
  };

  const addTag = (e: React.FormEvent) => {
    e.preventDefault();
    let tag = newTag.trim();
    if (!tag) return;
    if (!tag.startsWith('#')) tag = '#' + tag;
    if (!tags.includes(tag)) onUpdateTags([...tags, tag]);
    setNewTag('');
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h3 className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">Projects</h3>
        <p className={NOTE}>
          Click a name to rename it, or the colour to change it. A project&apos;s folder is also the one read for activity suggestions.
          An archived project leaves the pickers but keeps its logs; one in the Trash can be restored.
        </p>
        {listed.length > 0 && (
          <ul className="v2-panel">
            {listed.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                folders={foldersOfProject(folders, p.id)}
                canHide={activeCount > 1}
                onRename={(name) => patch(p.id, { name })}
                onColor={(color) => patch(p.id, { color })}
                onToggleArchive={() => patch(p.id, { isArchived: !p.isArchived })}
                onTrash={() => onTrashProject(p.id)}
                onSetFolder={(oldPath, path) => onSetProjectFolder(p.id, oldPath, path)}
                onRemoveFolder={onRemoveProjectFolder}
              />
            ))}
          </ul>
        )}
        {activeCount <= 1 && <p className={NOTE}>Keep at least one active project.</p>}

        <form onSubmit={addProject} className="flex flex-col gap-3 border-t border-[var(--border-app)] pt-4">
          <h4 className="text-[length:var(--fs-small)] font-semibold text-[var(--text-main)]">New project</h4>
          <div className="min-w-[12rem]">
            <label htmlFor={`${id}-name`} className={LABEL}>
              Project name
            </label>
            <input
              id={`${id}-name`}
              type="text"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setNote(null);
              }}
              placeholder="Project name"
              autoComplete="off"
              className={FIELD}
            />
          </div>
          <Swatches value={newColor} label="Colour of the new project" onPick={setNewColor} />
          <FolderField
            id={`${id}-folder`}
            label="Folder (optional)"
            path={newPath}
            onPath={(p) => {
              setNewPath(p);
              setNote(null);
            }}
            onPicked={folderChosen}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={!newName.trim() && !newPath.trim()} className={`${BTN} v2-btn-strong`}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add project
            </button>
            {note && (
              <p role="status" className={`text-[length:var(--fs-small)] ${note.ok ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}`}>
                {note.message}
              </p>
            )}
          </div>
        </form>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">Tags</h3>
        <p className={NOTE}>Tags you can attach to a log. Removing one does not change logs that already have it.</p>
        {tags.length === 0 ? (
          <p className={NOTE}>No tags yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <li
                key={t}
                className="inline-flex items-center gap-1 rounded-[var(--radius-btn)] border border-[var(--border-app)] bg-[var(--bg-subtle)] pl-3 text-[length:var(--fs-small)] text-[var(--text-main)]"
              >
                {t}
                <IconButton label={`Remove tag ${t}`} onClick={() => onUpdateTags(tags.filter((x) => x !== t))}>
                  <X className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addTag} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <label htmlFor={`${id}-tag`} className={LABEL}>
              New tag
            </label>
            <input
              id={`${id}-tag`}
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="#deep-work"
              autoComplete="off"
              className={FIELD}
            />
          </div>
          <button type="submit" disabled={!newTag.trim()} className={BTN}>
            Add tag
          </button>
        </form>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">Trash</h3>
        {trashed.length === 0 ? (
          <p className={NOTE}>Nothing in the Trash. A project you move here keeps its tasks and logs until you delete it for good.</p>
        ) : (
          <ul className="v2-panel">
            {trashed.map((p) => (
              <li key={p.id} className="v2-row v2-inset">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    className="block h-5 w-5 shrink-0 rounded-[var(--radius-btn)] border border-[var(--border-control)]"
                    style={{ backgroundColor: p.color }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 basis-40 text-[length:var(--fs-body)] font-semibold text-[var(--text-muted)]">{p.name}</span>
                  <button type="button" onClick={() => onRestoreProject(p.id)} aria-label={`Restore ${p.name}`} className={TEXT_BTN}>
                    Restore
                  </button>
                  <button type="button" onClick={() => setDeleting(p)} aria-label={`Delete ${p.name} forever`} className={TEXT_BTN}>
                    Delete forever
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {deleting && (
        <DeleteForeverDialog
          project={deleting}
          use={projectUse(deleting.id, backlog, logs)}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            onDeleteProjectForever(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
};
