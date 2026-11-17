import { useEffect, useRef } from 'react';
import type { AppSettings, StandupRecord, WorkLog, Workdays } from '../types';
import { cancelDayEmail, saveHistory, sendDayEmail, type PhoneApiResult } from '../utils/phoneApi';
import { health } from '../utils/health/registry';
import { EMAIL_DELAY_MINUTES, daysToDeliver, historyRow, readDelivery, standupRow, writeDelivery } from '../utils/jobs/delivery';
import { retryDelayMs } from '../utils/jobs/journal';

// Sends each closed day to the Google Sheet (day history and the standup) and books the standup email for about 30
// minutes later, from the user's own Gmail through their Apps Script (version 6). Done once per day; a failure is tried
// again later with growing waits; a Resume cancels a booked email. Needs the evening email switched on and the phone
// access set up. A day with nothing logged has no standup, so no email goes out for it.

const TICK_MS = 2 * 60_000;

export function useDelivery(args: {
  enabled: boolean;
  settings: AppSettings;
  workdays: Workdays;
  logs: WorkLog[];
  standups: StandupRecord[];
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
      const { settings, workdays, logs, standups } = latest.current;
      const url = settings.googleScriptUrl;
      const token = settings.phoneToken;
      if (!url || !token || settings.emailEnabled !== true) return;
      const now = Date.now();
      const delivery = readDelivery(localStorage);

      busy = true;
      try {
        // A day that was reopened: its booked email is cancelled and the day is looked at again after its next clock-out.
        for (const [date, entry] of Object.entries(delivery)) {
          if (entry.state === 'queued' && workdays[date] && !workdays[date].clockOut) {
            const r = await cancelDayEmail(url, token, { kind: 'day', date });
            if (r.ok || r.code === 'script_old') {
              const next = readDelivery(localStorage);
              delete next[date];
              writeDelivery(localStorage, next);
            }
          }
        }
        const date = daysToDeliver({ workdays, standups, delivery: readDelivery(localStorage), nowMs: now }).find((d) => (failures.get(d)?.retryAt ?? 0) <= now);
        if (!date || cancelled) return;

        const day = standups.find((s) => s.id === `day:${date}`);
        const week = standups.find((s) => s.id === `week:${date}`);
        const rows = [day, week].filter((s): s is StandupRecord => !!s).map(standupRow);
        const saved = await saveHistory(url, token, { days: [historyRow(date, workdays, logs)], standups: rows });
        let outcome: PhoneApiResult<unknown> = saved;
        if (saved.ok) {
          const mails = [await sendDayEmail(url, token, { kind: 'day', date }, { delayMinutes: EMAIL_DELAY_MINUTES, requestId: `day-${date}` })];
          if (week) mails.push(await sendDayEmail(url, token, { kind: 'week', from: week.from, to: week.to }, { delayMinutes: EMAIL_DELAY_MINUTES, requestId: `week-${date}` }));
          outcome = mails.find((m) => !m.ok) ?? mails[0];
        }
        if (outcome.ok) {
          const next = readDelivery(localStorage);
          next[date] = { state: 'queued', at: new Date().toISOString(), ...(week ? { week: true } : {}) };
          writeDelivery(localStorage, next);
          failures.delete(date);
          health.reportOk('email');
        } else if (outcome.code === 'script_old') {
          // The Sheet script is older than version 6: nothing to retry until it is updated (Settings shows the steps).
          failures.set(date, { n: 99, retryAt: now + 6 * 3600_000 });
          health.reportFail('email', { message: 'Your Sheet script needs the version 6 update before standups can be emailed.', retryable: false });
        } else {
          const n = (failures.get(date)?.n ?? 0) + 1;
          failures.set(date, { n, retryAt: Date.now() + retryDelayMs(n) });
          health.reportFail('email', { message: outcome.message, retryable: true });
        }
      } finally {
        busy = false;
      }
    };

    const first = setTimeout(() => void tick(), 45_000);
    const id = setInterval(() => void tick(), TICK_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [args.enabled]);
}
