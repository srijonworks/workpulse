import type { StandupRecord, WorkLog, Workdays } from '../../types';
import { localDateStr } from '../dates';
import type { DayHistoryRow, StandupRow } from '../phoneApi';

// Sending a closed day to the Google Sheet and mailing its standup, once. Which days still need it, and the rows to send.
// Device-only record in `workpulse_delivery`. Pure: the storage is passed in.

export const DELIVERY_KEY = 'workpulse_delivery';
export const DELIVERY_CATCH_UP_DAYS = 7;

export interface DeliveryEntry {
  /** 'queued': the Sheet has the rows and the email is booked (or sent); the day is not looked at again. */
  state: 'queued';
  at: string;
  /** Set for a Thursday's week standup, once it is queued too. */
  week?: boolean;
}
export type Delivery = Record<string, DeliveryEntry>;

interface KVLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readDelivery(kv: KVLike): Delivery {
  try {
    const v = JSON.parse(kv.getItem(DELIVERY_KEY) ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Delivery = {};
    for (const [d, e] of Object.entries(v as Record<string, Partial<DeliveryEntry>>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && e && e.state === 'queued') out[d] = { state: 'queued', at: typeof e.at === 'string' ? e.at : '', ...(e.week ? { week: true } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeDelivery(kv: KVLike, d: Delivery): boolean {
  try {
    const kept = Object.fromEntries(Object.entries(d).sort(([a], [b]) => a.localeCompare(b)).slice(-60));
    kv.setItem(DELIVERY_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}

const isThursday = (date: string): boolean => new Date(`${date}T12:00:00`).getDay() === 4;

/** The closed days (newest week) that have a saved day standup and are not queued yet, oldest first. */
export function daysToDeliver(o: { workdays: Workdays; standups: StandupRecord[]; delivery: Delivery; nowMs: number }): string[] {
  const oldest = localDateStr(new Date(o.nowMs - DELIVERY_CATCH_UP_DAYS * 24 * 3600 * 1000));
  const have = new Set(o.standups.map((s) => s.id));
  return Object.keys(o.workdays)
    .filter((d) => {
      const w = o.workdays[d];
      if (!w.clockOut || d < oldest || !have.has(`day:${d}`)) return false;
      const done = o.delivery[d];
      if (!done) return true;
      return isThursday(d) && have.has(`week:${d}`) && !done.week; // the week standup came later
    })
    .sort();
}

const minutesBetween = (a: string, b: string): number => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));

export function historyRow(date: string, workdays: Workdays, logs: WorkLog[]): DayHistoryRow {
  const w = workdays[date];
  const day = logs.filter((l) => l.date === date);
  return {
    date,
    clockIn: w?.clockIn,
    clockOut: w?.clockOut,
    workedMinutes: w?.clockOut ? minutesBetween(w.clockIn, w.clockOut) : 0,
    loggedMinutes: day.reduce((n, l) => n + (l.durationMinutes ?? 0), 0),
    logCount: day.length,
    closedAt: w?.clockOut,
  };
}

export function standupRow(s: StandupRecord): StandupRow {
  return { id: s.id, kind: s.kind, from: s.from, to: s.to, text: s.text, writer: s.writer, createdAt: s.createdAt, editedAt: s.editedAt };
}
