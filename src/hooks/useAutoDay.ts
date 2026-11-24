import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, WorkLog, Workdays } from '../types';
import { scanActivityApi } from '../utils/activity/client';
import { foldersWithRealWork } from '../utils/activity/autoProjects';
import { noticeSignature } from '../utils/activity/pipeline';
import { aiFromSettings, sourcesFromSettings } from '../utils/activity/settings';
import { decideAutoClockOut } from '../utils/autoDay/autoClockOut';
import { busyWindows } from '../utils/autoDay/busy';
import { decideStartPrompt } from '../utils/autoDay/startPrompt';
import { localDateStr } from '../utils/dates';
import { desktopBridge } from '../utils/desktopBridge';
import { DEFAULT_WORKDAY_HOURS } from '../utils/workday';

// The automatic parts of the office clock: the start-of-day popup, and the safety-net clock-out. The decisions are in
// utils/autoDay (pure); this hook feeds them what the page knows and acts on the answer. Nothing here ever clocks in
// by itself without the popup, and a manual clock-out is never undone.

const TICK_MS = 60_000;
const WEEKEND_SCAN_MS = 10 * 60_000;
/** Before an automatic clock-out, today's git, AI and file activity is read again if the last read is older than this. */
const CLOCK_OUT_SCAN_MS = 10 * 60_000;
const NOTICE_KEY = 'workpulse_activity_notice';
const DISMISSED_KEY = 'workpulse_autoday_dismissed';

const readDismissed = (): string | null => {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
};

export function useAutoDay(args: {
  enabled: boolean;
  workdays: Workdays;
  logs: WorkLog[];
  settings: AppSettings;
  /** The last heartbeat of the previous run (see useHeartbeat). */
  lastAliveMs: number | null;
  /** Opens the clock-in popup with this suggested time (ISO). */
  openStartPrompt: (suggestedIso: string) => void;
  /** Whether the popup is open now. */
  promptOpen: boolean;
  /** Closes the day `date` at this time (ISO), as the safety net. */
  autoClockOut: (date: string, atIso: string) => void;
}): { getLastActivityMs: () => number | null; dismissToday: () => void } {
  const latest = useRef(args);
  latest.current = args;
  const lastActivity = useRef<number | null>(null);
  const realWorkAt = useRef<number | null>(null);
  // The latest activity item (commit, AI prompt, changed file) found today, and when that was last read.
  const scanned = useRef<{ date: string; latestMs: number | null; readAtMs: number }>({ date: '', latestMs: null, readAtMs: 0 });
  // The last activity seen in this run per local date, so a day still open at midnight closes at its real end.
  const byDate = useRef<Record<string, number>>({});
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;

  // Someone is using the PC: any input in this window. (The window is often in the tray: the decision below also uses the
  // desktop shell's PC-wide idle time and today's activity items.)
  useEffect(() => {
    if (!args.enabled) return;
    lastActivity.current = Date.now();
    let last = 0;
    const mark = () => {
      const now = Date.now();
      if (now - last < 5_000) return; // not on every mouse move
      last = now;
      lastActivity.current = now;
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'focus', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, mark, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, mark);
    };
  }, [args.enabled]);

  // Friday and Saturday: look for real work now and then, so the popup can show when someone does work.
  useEffect(() => {
    if (!args.enabled) return;
    let cancelled = false;
    const probe = async () => {
      const { settings } = latest.current;
      const weekday = new Date().getDay();
      if (weekday !== 5 && weekday !== 6) return;
      const folders = settings.activityFolders ?? [];
      let accepted = false;
      try {
        accepted = localStorage.getItem(NOTICE_KEY) === noticeSignature(sourcesFromSettings(settings), aiFromSettings(settings));
      } catch {
        accepted = false;
      }
      if (!accepted || folders.length === 0) return;
      try {
        const scan = await scanActivityApi({ date: localDateStr(), folders, sources: sourcesFromSettings(settings) });
        if (cancelled) return;
        const real = new Set(foldersWithRealWork(scan.items));
        const times = scan.items.filter((i) => real.has(i.folder)).map((i) => Date.parse(i.time));
        realWorkAt.current = times.length > 0 ? Math.min(...times) : null;
      } catch {
        // tried again in 10 minutes
      }
    };
    void probe();
    const id = setInterval(() => void probe(), WEEKEND_SCAN_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [args.enabled]);

  // The decisions, every minute and when the window comes back.
  useEffect(() => {
    if (!args.enabled) return;
    let cancelled = false;
    let running = false;
    // Seconds since the last input anywhere on the PC, from the desktop shell; null in a browser or on failure.
    const pcIdleSeconds = async (): Promise<number | null> => {
      const bridge = desktopBridge();
      if (!bridge?.getIdleSeconds) return null;
      try {
        const v = await bridge.getIdleSeconds();
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
      } catch {
        return null;
      }
    };
    // Reads today's activity again and keeps the time of its latest item (never in the future).
    const rescan = async (today: string, nowMs: number) => {
      const { settings } = latest.current;
      scanned.current = { ...scanned.current, readAtMs: nowMs };
      const folders = settings.activityFolders ?? [];
      let accepted = false;
      try {
        accepted = localStorage.getItem(NOTICE_KEY) === noticeSignature(sourcesFromSettings(settings), aiFromSettings(settings));
      } catch {
        accepted = false;
      }
      if (!accepted || folders.length === 0) return;
      try {
        const scan = await scanActivityApi({ date: today, folders, sources: sourcesFromSettings(settings) });
        const times = scan.items.map((i) => Date.parse(i.time)).filter((t) => Number.isFinite(t) && t <= nowMs);
        scanned.current = { date: today, latestMs: times.length > 0 ? Math.max(...times) : null, readAtMs: nowMs };
      } catch {
        // window input and the PC idle time still decide
      }
    };
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await decide();
      } finally {
        running = false;
      }
    };
    const decide = async () => {
      const idleSec = await pcIdleSeconds();
      if (cancelled) return;
      const now = new Date();
      const nowMs = now.getTime();
      const today = localDateStr(now);
      const activity = () => {
        const seen = [lastActivity.current, idleSec === null ? null : nowMs - idleSec * 1000, scanned.current.date === today ? scanned.current.latestMs : null].filter(
          (t): t is number => t !== null,
        );
        const ms = seen.length > 0 ? Math.max(...seen) : null;
        if (ms !== null) {
          const d = localDateStr(new Date(ms));
          byDate.current = Object.fromEntries(
            Object.entries({ ...byDate.current, [d]: Math.max(byDate.current[d] ?? 0, ms) })
              .sort(([x], [y]) => (x < y ? -1 : 1))
              .slice(-3),
          );
        }
        return ms;
      };
      const ask = () => {
        const a = latest.current;
        return decideAutoClockOut({
          workdays: a.workdays,
          today,
          nowMs,
          lastActivityMs: activity(),
          wholePc: idleSec !== null,
          activityByDate: byDate.current,
          lastAliveMs: a.lastAliveMs,
          hours: a.settings.workdayHours ?? DEFAULT_WORKDAY_HOURS,
          busy: busyWindows(a.logs, today),
        });
      };
      let out = ask();
      // Before closing today, look at today's commits, AI prompts and files once more: work outside this window counts.
      if (out.action === 'clock-out' && out.date === today && nowMs - scanned.current.readAtMs >= CLOCK_OUT_SCAN_MS) {
        await rescan(today, nowMs);
        if (cancelled) return;
        out = ask();
      }
      const a = latest.current;
      if (out.action === 'clock-out') {
        a.autoClockOut(out.date, new Date(out.atMs).toISOString());
        return; // the next tick looks at the next day
      }
      if (a.promptOpen) return;
      const start = decideStartPrompt({ workdays: a.workdays, today, nowMs, weekday: now.getDay(), realWorkAtMs: realWorkAt.current, dismissedDate: dismissedRef.current });
      if (start.action === 'show') a.openStartPrompt(new Date(start.suggestedMs).toISOString());
    };
    const first = setTimeout(() => void tick(), 3_000);
    const id = setInterval(() => void tick(), TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [args.enabled]);

  const getLastActivityMs = useCallback(() => lastActivity.current, []);
  const dismissToday = useCallback(() => {
    const today = localDateStr();
    setDismissed(today);
    try {
      localStorage.setItem(DISMISSED_KEY, today);
    } catch {
      // the popup may show again after a reload
    }
  }, []);
  return { getLastActivityMs, dismissToday };
}
