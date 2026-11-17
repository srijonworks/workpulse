import type { Project } from '../types';
import type { ActivityFolder } from './activity/types';
import { planProjectWithFolder } from './projectFromFolder';

// "Add all projects in a folder": one project per chosen folder, each linked to its folder, in one go. Built on the same rule
// as the New project form (the project with the same name is reused, a new one takes the next colour). Pure.

export interface BulkPlan {
  projects: Project[];
  folders: ActivityFolder[];
  created: number;
  /** Folders linked to a project that already existed (same name). */
  reused: number;
  /** Folders that were not added, with the plain reason (already linked, bad path). */
  skipped: { path: string; reason: string }[];
}

export function planBulkProjects(projects: Project[], folders: ActivityFolder[], paths: string[], baseId: number): BulkPlan {
  let ps = projects;
  let fs = folders;
  let created = 0;
  let reused = 0;
  const skipped: { path: string; reason: string }[] = [];
  paths.forEach((path, i) => {
    const plan = planProjectWithFolder(ps, fs, { path }, `proj-${baseId}-${i}`);
    if (!plan.ok) {
      skipped.push({ path, reason: plan.message });
      return;
    }
    ps = plan.projects;
    fs = plan.folders;
    if (plan.created) created++;
    else reused++;
  });
  return { projects: ps, folders: fs, created, reused, skipped };
}

/** One plain sentence for the result. */
export function bulkMessage(p: BulkPlan): string {
  const parts: string[] = [];
  if (p.created > 0) parts.push(`${p.created} project${p.created === 1 ? '' : 's'} added`);
  if (p.reused > 0) parts.push(`${p.reused} folder${p.reused === 1 ? '' : 's'} linked to a project you already had`);
  if (p.skipped.length > 0) parts.push(`${p.skipped.length} skipped`);
  return parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing was added.';
}
