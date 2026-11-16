import type { AppSettings } from '../../types';
import type { ActivityAi, ActivityFolder, ActivitySources } from './types';

/** A full path: a Windows drive path (E:\x or E:/x) or an absolute POSIX path. */
export function isFullFolderPath(text: string): boolean {
  const t = text.trim();
  return /^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/');
}

export const sameFolderKey = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// "E:\app\" -> "E:\app", but a drive root such as "E:\" stays as it is.
const tidyPath = (p: string): string => {
  const t = p.trim();
  if (/^[A-Za-z]:[\\/]+$/.test(t) || /^\/+$/.test(t)) return t;
  return t.replace(/[\\/]+$/, '');
};

export type AddFolderResult = { ok: true; folders: ActivityFolder[] } | { ok: false; error: string };

export function addActivityFolder(folders: ActivityFolder[], rawPath: string, projectId: string): AddFolderResult {
  if (!isFullFolderPath(rawPath)) return { ok: false, error: 'Enter the full folder path, like E:\\projects\\app.' };
  if (!projectId) return { ok: false, error: 'Pick a project for this folder first.' };
  const path = tidyPath(rawPath);
  if (folders.some((f) => sameFolderKey(f.path) === sameFolderKey(path))) {
    return { ok: false, error: 'That folder is already in the list.' };
  }
  return { ok: true, folders: [...folders, { path, projectId }] };
}

/** Git commits, Claude Code, OpenCode and Codex prompts are all on unless switched off. */
export function sourcesFromSettings(s: Pick<AppSettings, 'activityUseClaude' | 'activityUseGit' | 'activityUseOpenCode' | 'activityUseCodex' | 'activityUseDocs'>): ActivitySources {
  return { claude: s.activityUseClaude !== false, git: s.activityUseGit !== false, opencode: s.activityUseOpenCode !== false, codex: s.activityUseCodex !== false, docs: s.activityUseDocs !== false };
}

/** The settings fields for these choices; only values that differ from the defaults are stored. */
export function activityFieldsFromSources(
  sources: ActivitySources,
): Pick<AppSettings, 'activityUseClaude' | 'activityUseGit' | 'activityUseOpenCode' | 'activityUseCodex' | 'activityUseDocs'> {
  return {
    activityUseClaude: sources.claude ? undefined : false,
    activityUseGit: sources.git ? undefined : false,
    activityUseOpenCode: sources.opencode !== false ? undefined : false,
    activityUseCodex: sources.codex !== false ? undefined : false,
    activityUseDocs: sources.docs !== false ? undefined : false,
  };
}

/** Claude Code unless another choice was saved. */
export function aiFromSettings(s: Pick<AppSettings, 'activityAi'>): ActivityAi {
  return s.activityAi ?? 'claude';
}

/** The writer's name for sentences like "Drafting with ...". */
export function aiWriterName(ai: ActivityAi): string {
  return ai === 'gemini' ? 'Gemini' : ai === 'none' ? 'a template' : 'Claude';
}

/** The settings value for this choice; the default is not stored. */
export function aiField(ai: ActivityAi): ActivityAi | undefined {
  return ai === 'claude' ? undefined : ai;
}

/** Checking for new activity in the background (every 5 minutes) is on unless switched off. */
export function autoScanFromSettings(s: Pick<AppSettings, 'activityAutoScan'>): boolean {
  return s.activityAutoScan !== false;
}
