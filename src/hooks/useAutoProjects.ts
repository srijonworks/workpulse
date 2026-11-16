import { useEffect, useRef } from 'react';
import type { AppSettings } from '../types';
import { discoverReposApi, scanActivityApi } from '../utils/activity/client';
import { autoProjectsEnabled, foldersWithRealWork, unlinkedRepos, watchFolderOf } from '../utils/activity/autoProjects';
import { noticeSignature } from '../utils/activity/pipeline';
import { aiFromSettings, sourcesFromSettings } from '../utils/activity/settings';
import { localDateStr } from '../utils/dates';

// Makes projects from the folders the user works in, without being asked. Every 10 minutes (and shortly after start) it
// looks for git projects in the watch folder that no project covers, reads today's activity in just those, and creates
// a project for each one with real work. It only runs after the user accepted the activity data notice, and never
// touches a folder in the ignored list.

const NOTICE_KEY = 'workpulse_activity_notice';
const FIRST_RUN_MS = 20_000;
const EVERY_MS = 10 * 60_000;
const MAX_PER_RUN = 5;

export function useAutoProjects(args: {
  enabled: boolean;
  settings: AppSettings;
  /** Creates the project and links the folder; the same function the "New project" form uses. */
  addProject: (input: { path: string }) => { ok: boolean; message: string };
  onCreated: (message: string) => void;
}): void {
  const latest = useRef(args);
  latest.current = args;

  useEffect(() => {
    if (!args.enabled) return;
    let busy = false;
    let cancelled = false;

    const run = async () => {
      const { settings, addProject, onCreated } = latest.current;
      if (busy || cancelled || !autoProjectsEnabled(settings)) return;
      let accepted = false;
      try {
        accepted = localStorage.getItem(NOTICE_KEY) === noticeSignature(sourcesFromSettings(settings), aiFromSettings(settings));
      } catch {
        accepted = false;
      }
      const watch = watchFolderOf(settings);
      if (!accepted || !watch) return;
      busy = true;
      try {
        const linked = settings.activityFolders ?? [];
        const candidates = unlinkedRepos(await discoverReposApi(watch), linked, settings.activityIgnoredFolders);
        if (candidates.length === 0 || cancelled) return;
        // Only these folders are read, so nothing else is looked at.
        const scan = await scanActivityApi({
          date: localDateStr(),
          folders: candidates.map((path) => ({ path, projectId: '' })),
          sources: sourcesFromSettings(settings),
        });
        for (const folder of foldersWithRealWork(scan.items).slice(0, MAX_PER_RUN)) {
          if (cancelled) return;
          const r = latest.current.addProject({ path: folder });
          if (r.ok) onCreated(r.message);
          // Let the screen take in the new project before the next one is made (each creation starts from the current list).
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      } catch {
        // A failed check is tried again in 10 minutes; nothing here is worth interrupting the user for.
      } finally {
        busy = false;
      }
    };

    const first = setTimeout(() => void run(), FIRST_RUN_MS);
    const id = setInterval(() => void run(), EVERY_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [args.enabled]);
}
