import React from 'react';
import type { Project } from '../../types';
import type { ActivityFolder, ActivitySources } from '../../utils/activity/types';
import { byDisplayRank } from '../../utils/activity/registry';

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

  const isOn = (id: string) => (sources as Record<string, boolean | undefined>)[id] !== false;
  // Settings order (git first); the auto-check box sits right after the first source, as it always has.
  const sourceBoxes = byDisplayRank().map((d) => (
    <label key={d.id} className="flex items-start gap-2.5 text-[length:var(--fs-small)] text-[var(--text-main)] cursor-pointer">
      <input
        type="checkbox"
        checked={isOn(d.id)}
        onChange={(e) => onSourcesChange({ ...sources, [d.id]: e.target.checked })}
        className="mt-0.5"
      />
      <span>
        <span className="font-semibold">{d.settingsText.title}</span>
        <span className="block text-[var(--text-muted)]">{d.settingsText.description}</span>
      </span>
    </label>
  ));

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-[length:var(--fs-small)] font-semibold text-[var(--text-main)]">What to read</legend>
        {sourceBoxes.slice(0, 1)}
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
        {sourceBoxes.slice(1)}
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
