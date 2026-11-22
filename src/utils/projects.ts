import { BacklogTask, Project, WorkLog } from '../types';
import type { ActivityFolder } from './activity/types';

export const isTrashed = (p: Project): boolean => !!p.trashedAt;

// Trashed projects are gone from every list and picker (Settings > Trash lists them); App hands the screens this.
export const liveProjectsOf = (projects: Project[]): Project[] => projects.filter((p) => !p.trashedAt);
export const trashedProjectsOf = (projects: Project[]): Project[] => projects.filter((p) => !!p.trashedAt);

// Archived and trashed projects are hidden from pickers; a log must never default to one (B13).
export const activeProjectsOf = (projects: Project[]): Project[] => projects.filter((p) => !p.isArchived && !p.trashedAt);

// First active project, or (if every project is archived) the first one that is not trashed.
export const defaultProject = (projects: Project[]): Project | undefined =>
  projects.find((p) => !p.isArchived && !p.trashedAt) || projects.find((p) => !p.trashedAt);

/** Moves a project to the Trash. It keeps its tasks, logs and folder links. */
export const trashProject = (projects: Project[], id: string, nowIso: string): Project[] =>
  projects.map((p) => (p.id === id && !p.trashedAt ? { ...p, trashedAt: nowIso } : p));

/** Brings a project back from the Trash (an archived one is still archived). */
export const restoreProject = (projects: Project[], id: string): Project[] =>
  projects.map((p) => {
    if (p.id !== id || !p.trashedAt) return p;
    const { trashedAt: _gone, ...rest } = p;
    return rest;
  });

/** Removes the project record and its folder links. Tasks and logs are left as they are. */
export function deleteProjectForever(
  projects: Project[],
  folders: ActivityFolder[],
  id: string,
): { projects: Project[]; folders: ActivityFolder[] } {
  return { projects: projects.filter((p) => p.id !== id), folders: folders.filter((f) => f.projectId !== id) };
}

/** How many tasks and logs point at this project (for the "Delete forever" warning). */
export const projectUse = (
  id: string,
  backlog: Pick<BacklogTask, 'projectId'>[],
  logs: Pick<WorkLog, 'projectId'>[],
): { tasks: number; logs: number } => ({
  tasks: backlog.filter((t) => t.projectId === id).length,
  logs: logs.filter((l) => l.projectId === id).length,
});

/** The folder shortened to its last two segments ("...\work\HMIS"); the full path goes in a tooltip. */
export function shortFolder(path: string): string {
  const t = path.trim();
  const drive = /^([A-Za-z]:)[\\/]*$/.exec(t);
  if (drive) return `${drive[1]}\\`;
  const parts = t.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return t;
  return `...\\${parts.slice(-2).join('\\')}`;
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Edit distance where swapping two neighbouring letters counts as one edit ("hmis" to "hims" is 1). */
export function typoDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The shortest tag that may be a typo: shorter words match too much by accident. */
const TYPO_MIN = 3;

/**
 * Active projects a "#word" names (case and spaces ignored). `exact` and `prefix` are sure matches; `close` are names whose
 * start is one typo away ("#hmis" for "hims"), offered only when nothing matches for sure.
 */
export function projectsForTag(tag: string, projects: Project[]): { exact?: Project; prefix: Project[]; close: Project[] } {
  const key = squash(tag);
  const active = activeProjectsOf(projects);
  const exact = active.find((p) => squash(p.name) === key);
  const prefix = active.filter((p) => squash(p.name).startsWith(key));
  const close =
    prefix.length === 0 && key.length >= TYPO_MIN
      ? active.filter((p) => typoDistance(key, squash(p.name).slice(0, key.length)) <= 1)
      : [];
  return { exact, prefix, close };
}

/** The project a typed tag picks: the exact name, else the first name it starts, else the only one a typo away. */
function projectOfTag(tag: string, projects: Project[]): Project | undefined {
  const r = projectsForTag(tag, projects);
  return r.exact ?? r.prefix[0] ?? (r.close.length === 1 ? r.close[0] : undefined);
}

/**
 * Quick-add inputs: a "#word" at the end (or at the start) picks a project by name: exact, else prefix, else the one project
 * a single typo away (case and spaces ignored, archived projects skipped). A matched tag is removed from the text; with no
 * match the text stays whole and `project` is absent.
 */
export function splitProjectTag(input: string, projects: Project[]): { text: string; tag?: string; project?: Project } {
  const end = /(?:^|\s)#(\S+)\s*$/.exec(input);
  if (end) {
    const project = projectOfTag(end[1], projects);
    // No match keeps the whole text: "#212" may be part of it ("Review PR #212").
    if (project) return { text: input.slice(0, end.index).trim(), tag: end[1], project };
  }
  // "#hims Fix the stock page": a project tag typed first, then the task.
  const start = /^\s*#(\S+)\s+(?=\S)/.exec(input);
  if (start && !/^\d+$/.test(start[1])) {
    const project = projectOfTag(start[1], projects);
    if (project) return { text: input.slice(start[0].length).trim(), tag: start[1], project };
  }
  return end ? { text: input.trim(), tag: end[1] } : { text: input.trim() };
}
