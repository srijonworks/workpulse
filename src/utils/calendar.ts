// Calendar maths for the date picker. Dates are local `YYYY-MM-DD` strings, compared as strings, never through UTC.

const pad = (n: number) => String(n).padStart(2, '0');

export const isoOf = (y: number, m0: number, d: number): string => `${y}-${pad(m0 + 1)}-${pad(d)}`;

/** Splits a valid `YYYY-MM-DD` into numbers (month 0-11), or null. */
export function parseIso(iso: string): { y: number; m0: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const m0 = Number(m[2]) - 1;
  const d = Number(m[3]);
  const probe = new Date(y, m0, d);
  return probe.getFullYear() === y && probe.getMonth() === m0 && probe.getDate() === d ? { y, m0, d } : null;
}

export interface Cell {
  iso: string;
  day: number;
  inMonth: boolean;
}

/** Six weeks of cells covering the month, weeks starting on Sunday (the office week here runs Sunday to Thursday). */
export function monthGrid(y: number, m0: number): Cell[] {
  const first = new Date(y, m0, 1);
  const start = new Date(y, m0, 1 - first.getDay());
  const cells: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ iso: isoOf(d.getFullYear(), d.getMonth(), d.getDate()), day: d.getDate(), inMonth: d.getMonth() === m0 });
  }
  return cells;
}

/** The month `delta` months from (y, m0). */
export function addMonths(y: number, m0: number, delta: number): { y: number; m0: number } {
  const d = new Date(y, m0 + delta, 1);
  return { y: d.getFullYear(), m0: d.getMonth() };
}

/** The date `delta` days from `iso`. */
export function addDaysIso(iso: string, delta: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const d = new Date(p.y, p.m0, p.d + delta);
  return isoOf(d.getFullYear(), d.getMonth(), d.getDate());
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Tue 17 Nov 2026", or '' for a value that is not a date. */
export function formatDate(iso: string): string {
  const p = parseIso(iso);
  if (!p) return '';
  const wd = new Date(p.y, p.m0, p.d).getDay();
  return `${WEEKDAYS_LONG[wd].slice(0, 3)} ${p.d} ${MONTHS[p.m0].slice(0, 3)} ${p.y}`;
}

/** "17 Nov 2026": short enough for a narrow field in every theme. */
export function formatDateShort(iso: string): string {
  const p = parseIso(iso);
  return p ? `${p.d} ${MONTHS[p.m0].slice(0, 3)} ${p.y}` : '';
}

/** "Tuesday 17 November 2026", for screen readers. */
export function formatDateLong(iso: string): string {
  const p = parseIso(iso);
  if (!p) return '';
  return `${WEEKDAYS_LONG[new Date(p.y, p.m0, p.d).getDay()]} ${p.d} ${MONTHS[p.m0]} ${p.y}`;
}

/** Whether `iso` is allowed by the optional limits. */
export const withinLimits = (iso: string, min?: string, max?: string): boolean => (!min || iso >= min) && (!max || iso <= max);
