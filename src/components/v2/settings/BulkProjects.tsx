import React, { useId, useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import type { ActivityFolder } from '../../../utils/activity/types';
import { discoverReposApi } from '../../../utils/activity/client';
import { sameFolderKey } from '../../../utils/activity/settings';
import { pickFolder } from '../../../utils/pickFolderClient';
import { folderProjectName } from '../../../utils/projectFromFolder';
import { ModalShell } from '../../ui/ModalShell';

// "Add all projects in a folder": choose the folder that holds your work, tick the projects found in it, and each becomes a
// project linked to its folder. Only git projects are listed (the folder itself and the ones one level below).

interface Props {
  folders: ActivityFolder[];
  /** Adds one project per path, all at once. Returns a plain sentence. */
  onAddMany(paths: string[]): { ok: boolean; message: string };
  onNote(note: { ok: boolean; message: string }): void;
}

const BTN = 'v2-btn inline-flex items-center justify-center gap-1.5 min-h-11 px-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

export const BulkProjects: React.FC<Props> = ({ folders, onAddMany, onNote }) => {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ root: string; repos: string[] } | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  const linked = (path: string) => folders.some((f) => sameFolderKey(f.path) === sameFolderKey(path));

  const choose = async () => {
    setBusy(true);
    const picked = await pickFolder();
    if (picked.kind === 'cancelled') return setBusy(false);
    if (picked.kind === 'error') {
      setBusy(false);
      return onNote({ ok: false, message: picked.message });
    }
    const repos = await discoverReposApi(picked.path);
    setBusy(false);
    if (repos.length === 0) {
      return onNote({ ok: false, message: 'No git projects were found in that folder. Add a project by hand with its folder instead.' });
    }
    setFound({ root: picked.path, repos });
    setTicked(new Set(repos.filter((r) => !linked(r))));
  };

  const toggle = (path: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const add = () => {
    if (!found) return;
    const res = onAddMany(found.repos.filter((r) => ticked.has(r)));
    onNote(res);
    setFound(null);
  };

  const free = found ? found.repos.filter((r) => !linked(r)) : [];

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">Add many at once</h3>
      <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">
        Choose the folder that holds your projects, like E:\Projects. Every git project inside it can become a project here, linked to its own folder.
      </p>
      <div>
        <button type="button" onClick={() => void choose()} disabled={busy} className={BTN}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FolderOpen className="h-4 w-4" aria-hidden="true" />}
          Add all projects in a folder
        </button>
      </div>

      {found && (
        <ModalShell
          onClose={() => setFound(null)}
          labelledBy={`${id}-t`}
          closeOnBackdrop
          className="w-full max-w-lg p-6 bg-[var(--bg-surface-elevated)] text-[var(--text-main)] border border-[var(--border-app)] rounded-[var(--radius-card)]"
        >
          <h2 id={`${id}-t`} className="text-[length:var(--fs-body)] font-bold">
            Projects found in {folderProjectName(found.root)}
          </h2>
          <p className="mt-1 text-[length:var(--fs-small)] text-[var(--text-muted)] break-all">{found.root}</p>
          <div className="mt-3 flex items-center gap-3 text-[length:var(--fs-small)]">
            <button type="button" onClick={() => setTicked(new Set(free))} className="font-semibold text-[var(--accent-text)] underline underline-offset-4 cursor-pointer">
              Select all
            </button>
            <button type="button" onClick={() => setTicked(new Set())} className="font-semibold text-[var(--accent-text)] underline underline-offset-4 cursor-pointer">
              Select none
            </button>
          </div>
          <ul className="mt-2 max-h-72 overflow-y-auto border border-[var(--border-app)] rounded-[var(--radius-card)]">
            {found.repos.map((r) => {
              const isLinked = linked(r);
              return (
                <li key={r} className="v2-row flex items-center gap-3 px-3 py-2 border-b border-[var(--border-app)] last:border-b-0">
                  <input
                    id={`${id}-${r}`}
                    type="checkbox"
                    checked={ticked.has(r)}
                    disabled={isLinked}
                    onChange={() => toggle(r)}
                    className="h-4 w-4 shrink-0 accent-[var(--accent-text)]"
                  />
                  <label htmlFor={`${id}-${r}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block truncate text-[length:var(--fs-body)] font-semibold">{folderProjectName(r)}</span>
                    <span className="block truncate text-[length:var(--fs-small)] text-[var(--text-muted)]" title={r}>
                      {isLinked ? 'Already linked to a project' : r}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setFound(null)}
              className="h-10 px-3 rounded-[var(--radius-btn)] text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-subtle)] cursor-pointer"
            >
              Cancel
            </button>
            <button type="button" onClick={add} disabled={ticked.size === 0} className={`${BTN} v2-btn-strong`}>
              {ticked.size === 0 ? 'Add projects' : `Add ${ticked.size} project${ticked.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
};
