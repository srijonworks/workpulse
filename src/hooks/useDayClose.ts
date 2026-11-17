import { useEffect, useRef } from 'react';
import type { AppSettings, BacklogTask, Project, WorkLog, Workdays } from '../types';
import { loadSuggestions, noticeSignature } from '../utils/activity/pipeline';
import { aiFromSettings, sourcesFromSettings } from '../utils/activity/settings';
import { suggestionToLogData } from '../utils/activity/suggestions';
import { localDateOfIso, localTimeStr } from '../utils/dates';
import { qualityFromSettings } from '../utils/activity/quality';
import { recordSkipped } from '../utils/activity/skipCount';
import { recordAiResult } from '../utils/aiResults';
import { dueDays, readJournal, retryDelayMs, writeJournal } from '../utils/jobs/journal';
import { isDoneUnlogged } from '../utils/taskLogging';

// Closes out each finished day on its own: two minutes after a clock-out (so a quick Resume cancels it), it reads
// that day's activity, writes the logs (marked "auto", with an Undo), and records the day in the journal so it is done
// once. Days missed while the PC was off are caught up (up to a week). It never touches logs written by hand, and it
// only runs after the user accepted the activity data notice.

const TICK_MS = 60_000;
const NOTICE_KEY = 'workpulse_activity_notice';

export function useDayClose(args: {
  enabled: boolean;
  workdays: Workdays;
  logs: WorkLog[];
  backlog: BacklogTask[];
  projects: Project[];
  settings: AppSettings;
  /** Adds the logs (origin 'auto') and tells the person, with an Undo. */
  addAutoLogs: (date: string, batch: Omit<WorkLog, 'id' | 'createdAt'>[]) => void;
}): void {
  const latest = useRef(args);
  latest.current = args;

  useEffect(() => {
    if (!args.enabled) return;
    let busy = false;
    let cancelled = false;
    const failures = new Map<string, { n: number; retryAt: number }>();

    const tick = async () => {
      if (busy || cancelled) return;
      const a = latest.current;
      const { settings } = a;
      let accepted = false;
      try {
        accepted = localStorage.getItem(NOTICE_KEY) === noticeSignature(sourcesFromSettings(settings), aiFromSettings(settings));
      } catch {
        accepted = false;
      }
      if (!accepted) return;
      const nowMs = Date.now();
      const journal = readJournal(localStorage);
      const date = dueDays({ workdays: a.workdays, journal, nowMs }).find((d) => (failures.get(d)?.retryAt ?? 0) <= nowMs);
      if (!date) return;

      busy = true;
      try {
        const clockOut = a.workdays[date]?.clockOut;
        const res = await loadSuggestions({
          date,
          folders: settings.activityFolders ?? [],
          sources: sourcesFromSettings(settings),
          projects: a.projects.filter((p) => !p.trashedAt),
          logs: a.logs,
          backlog: a.backlog,
          geminiApiKey: settings.geminiApiKey ?? '',
          ai: aiFromSettings(settings),
          tasks: a.backlog.filter((t) => isDoneUnlogged(t) && t.completedAt && localDateOfIso(t.completedAt) === date),
          quality: qualityFromSettings(settings),
        });
        recordSkipped(localStorage, date, res.skipped ?? 0);
        if (aiFromSettings(settings) !== 'none') recordAiResult(localStorage, res.notice ? 'template' : aiFromSettings(settings) === 'gemini' ? 'gemini' : 'claude', res.notice);
        if (cancelled) return;
        // A Resume during the scan reopens the day: leave it for the next clock-out.
        const stillClosed = latest.current.workdays[date]?.clockOut;
        if (!stillClosed) return;
        const time = clockOut ? localTimeStr(new Date(clockOut)) : '17:00';
        const batch = res.suggestions.map((s) => ({ ...suggestionToLogData(s, date, s.minutes, s.text, s.projectId, s.projectName, s.subtasks), time }));
        if (batch.length > 0) latest.current.addAutoLogs(date, batch);
        writeJournal(localStorage, { ...readJournal(localStorage), [date]: { state: batch.length > 0 ? 'done' : 'empty', at: new Date().toISOString(), added: batch.length } });
        failures.delete(date);
      } catch {
        // The scan or the AI failed (the server was busy, a folder was slow): try this day again later, backing off.
        const n = (failures.get(date)?.n ?? 0) + 1;
        failures.set(date, { n, retryAt: Date.now() + retryDelayMs(n) });
      } finally {
        busy = false;
      }
    };

    const first = setTimeout(() => void tick(), 15_000);
    const id = setInterval(() => void tick(), TICK_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [args.enabled]);
}
