import React from 'react';
import type { Project } from '../../types';
import type { ActivityFolder, ActivitySources } from '../../utils/activity/types';

interface ActivityFoldersSettingsProps {
  folders: ActivityFolder[];
  sources: ActivitySources;
  projects: Project[];
  onSourcesChange: (sources: ActivitySources) => void;
  autoScan: boolean;
  onAutoScanChange: (on: boolean) => void;
}

export const ActivityFoldersSettings: React.FC<ActivityFoldersSettingsProps> = ({ folders, sources, projects, onSourcesChange, autoScan, onAutoScanChange }) => {
  const projectName = (id: string) => {
    const p = projects.find((x) => x.id === id);
    return p ? (p.trashedAt ? `${p.name} (in the Trash)` : p.name) : 'Project removed';
  };

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-[length:var(--fs-small)] font-semibold text-[var(--text-main)]">What to read</legend>
        <label className="flex items-start gap-2.5 text-[length:var(--fs-small)] text-[var(--text-main)] cursor-pointer">
          <input
            type="checkbox"
            checked={sources.git}
            onChange={(e) => onSourcesChange({ ...sources, git: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">Include git commits</span>
            <span className="block text-[var(--text-muted)]">
              Commits you made today in these folders.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-[length:var(--fs-small)] text-[var(--text-main)] cursor-pointer">
          <input
            type="checkbox"
            checked={autoScan}
            onChange={(e) => onAutoScanChange(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">Check for new activity every 5 minutes</span>
            <span className="block text-[var(--text-muted)]">
              While Today or End my day is open, new commits and prompts appear on their own. Your edits are never replaced.
              The first check still waits for your OK. Use Scan again for an instant check.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-[length:var(--fs-small)] text-[var(--text-main)] cursor-pointer">
          <input
            type="checkbox"
            checked={sources.claude}
            onChange={(e) => onSourcesChange({ ...sources, claude: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">Include Claude Code prompts</span>
            <span className="block text-[var(--text-muted)]">
              Reads your Claude Code session history for these folders: the first line of your prompts, session titles
              and edited file names. File contents are never read.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-[length:var(--fs-small)] text-[var(--text-main)] cursor-pointer">
          <input
            type="checkbox"
            checked={sources.opencode !== false}
            onChange={(e) => onSourcesChange({ ...sources, opencode: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">Include OpenCode prompts</span>
            <span className="block text-[var(--text-muted)]">
              Reads your OpenCode history on this computer for these folders: the first line of your prompts only.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-[length:var(--fs-small)] text-[var(--text-main)] cursor-pointer">
          <input
            type="checkbox"
            checked={sources.codex !== false}
            onChange={(e) => onSourcesChange({ ...sources, codex: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">Include Codex prompts</span>
            <span className="block text-[var(--text-muted)]">
              Reads your Codex CLI history on this computer for these folders: the first line of your prompts only.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="space-y-3">
        <h4 className="text-[length:var(--fs-small)] font-semibold text-[var(--text-main)]">Folders</h4>
        <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">
          Folders come from Projects & tags: choose a project&apos;s folder there.
        </p>
        {folders.length === 0 ? (
          <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">No folders linked yet.</p>
        ) : (
          <ul className="space-y-1">
            {folders.map((f) => (
              <li key={f.path} className="flex flex-wrap items-baseline gap-x-2 text-[length:var(--fs-small)] text-[var(--text-main)]">
                <span className="min-w-0 truncate font-mono" title={f.path}>{f.path}</span>
                <span className="text-[var(--text-muted)]">{projectName(f.projectId)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[length:var(--fs-small)] text-[var(--text-muted)]">
          A folder covers itself, any git project one level below it, and Claude Code sessions started inside it.
        </p>
      </div>
    </div>
  );
};
