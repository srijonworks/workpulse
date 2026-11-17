import { useEffect, useRef } from 'react';
import type { AppSettings, BacklogTask, Project, WorkLog, Workdays } from '../types';
import { loadSuggestions, noticeSignature } from '../utils/activity/pipeline';
import { qualityFromSettings } from '../utils/activity/quality';
import { aiFromSettings, sourcesFromSettings } from '../utils/activity/settings';
import { recordSkipped } from '../utils/activity/skipCount';
import { getActivitySession, rowTouched, setActivitySession } from '../utils/activity/sessionStore';
import { suggestionToLogData } from '../utils/activity/suggestions';
import { recordAiResult } from '../utils/aiResults';
import { localDateStr, localTimeStr } from '../utils/dates';

// Adds logs while you work. Every 10 minutes, while a workday is open, it reads today's activity and adds a log for each piece of
// work that is worth one (see utils/activity/significance): small work waits in the "Maybe" list on Today, trivia is left out.
// Each log is marked "auto" with an Undo. It needs the activity data notice to have been accepted and folders linked to projects,
// and it can be switched off in Settings. It never touches logs written by hand.

const FIRST_MS = 20_000;
const EVERY_MS = 10 * 60_000;
const NOTICE_KEY = 'workpulse_activity_notice';

export function useLiveActivity(args: {
  enabled: boolean;
  workdays: Workdays;
  logs: WorkLog[];
  backlog: BacklogTask[];
  projects: Project[];
  settings: AppSettings;
  addAutoLogs: (date: string, batch: Omit<WorkLog, 'id' | 'createdAt'>[]) => void;
}): void {
  const latest = useRef(args);
  latest.current = args;

  useEffect(() => {
    if (!args.enabled) return;
    let busy = false;
    let cancelled = false;

    const run = async () => {
      if (busy || cancelled) return;
      const a = latest.current;
      const { settings } = a;
      if (settings.activityAutoAdd === false || (settings.activityFolders ?? []).length === 0) return;
      const today = localDateStr();
      const day = a.workdays[today];
      if (!day || day.clockOut) return; // only while a workday is open
      let accepted = false;
      try {
        accepted = localStorage.getItem(NOTICE_KEY) === noticeSignature(sourcesFromSettings(settings), aiFromSettings(settings));
      } catch {
        accepted = false;
      }
      if (!accepted) return;
      // Someone is editing a suggestion on Today: do not change the list under their hands.
      const kept = getActivitySession(today);
      if (kept?.rows.some(rowTouched)) return;

      busy = true;
      try {
        const r = await loadSuggestions({
          date: today,
          folders: settings.activityFolders ?? [],
          sources: sourcesFromSettings(settings),
          projects: a.projects.filter((p) => !p.trashedAt),
          logs: a.logs,
          backlog: a.backlog,
          geminiApiKey: settings.geminiApiKey ?? '',
          ai: aiFromSettings(settings),
          tasks: [], // done tasks are logged by the day-close job and "Log it", not here
          quality: qualityFromSettings(settings),
        });
        if (cancelled) return;
        recordSkipped(localStorage, today, r.skipped ?? 0);
        if (aiFromSettings(settings) !== 'none') recordAiResult(localStorage, r.notice ? 'template' : aiFromSettings(settings) === 'gemini' ? 'gemini' : 'claude', r.notice);
        if (r.suggestions.length === 0) return;
        const time = localTimeStr();
        const batch = r.suggestions.map((s) => ({ ...suggestionToLogData(s, today, s.minutes, s.text, s.projectId, s.projectName, s.subtasks), time }));
        latest.current.addAutoLogs(today, batch);
        // The card on Today must not offer again what was just added.
        const used = new Set(r.suggestions.flatMap((s) => s.itemIds));
        const cur = getActivitySession(today);
        if (cur) {
          setActivitySession(today, {
            ...cur,
            rows: cur.rows.filter((row) => !row.suggestion.itemIds.some((id) => used.has(id))),
            result: { ...cur.result, maybe: (cur.result.maybe ?? []).filter((m) => !m.itemIds.some((id) => used.has(id))) },
          });
        }
      } catch {
        // A failed read is tried again in 10 minutes; nothing here is worth interrupting the person for.
      } finally {
        busy = false;
      }
    };

    const first = setTimeout(() => void run(), FIRST_MS);
    const id = setInterval(() => void run(), EVERY_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [args.enabled]);
}
