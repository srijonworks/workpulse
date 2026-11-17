import { useCallback, useRef } from 'react';
import type { AppSettings, BacklogTask, StandupRecord, WorkLog, Workdays } from '../types';
import { generateAiReport, type ReportPeriod } from '../utils/aiGenerator';
import { recordAiResult } from '../utils/aiResults';
import { applyRewrite, needsRewrite } from '../utils/standupRewrite';
import { dayPeriod, standupContext, upsertStandup, weekPeriod, type StandupPeriod } from '../utils/standup';

export interface WriterResult {
  text: string;
  writer: StandupRecord['writer'];
  notice?: string;
}

/** Writes one standup. Injected so tests need no network. */
export type StandupWriter = (i: { logs: WorkLog[]; period: ReportPeriod; context: string; settings: AppSettings }) => Promise<WriterResult>;

/** Claude first, then Gemini when a key exists, then the plain template. The notice says why a fallback happened. */
export const chainWriter: StandupWriter = async ({ logs, period, context, settings }) => {
  const pref = settings.activityAi ?? 'claude';
  const key = settings.geminiApiKey?.trim();
  const order: ('claude' | 'gemini')[] =
    pref === 'none' ? [] : pref === 'gemini' ? ['gemini', 'claude'] : key ? ['claude', 'gemini'] : ['claude'];
  let notice: string | undefined;
  let templateText: string | undefined;
  for (const ai of order) {
    if (ai === 'gemini' && !key) continue;
    const r = await generateAiReport({ logs, format: 'slack', tone: 'casual', ai, customApiKey: key, period, context });
    if (r.source === ai) return { text: r.text, writer: ai, notice };
    notice = notice ?? r.error;
    templateText = r.text;
  }
  if (templateText === undefined) {
    const r = await generateAiReport({ logs, format: 'slack', tone: 'casual', ai: 'none', period });
    templateText = r.text;
  }
  return { text: templateText, writer: 'template', notice };
};

export interface StandupDeps {
  enabled: boolean;
  logs: WorkLog[];
  backlog: BacklogTask[];
  settings: AppSettings;
  workdays: Workdays;
  standups: StandupRecord[];
  setStandups: (f: (prev: StandupRecord[]) => StandupRecord[]) => void;
  writer?: StandupWriter;
  now?: () => string;
}

/** Writes the standup for `period` unless one exists already. Returns the record written, or null. */
export async function writeStandupOnce(d: StandupDeps, period: StandupPeriod, inFlight: Set<string>): Promise<StandupRecord | null> {
  if (!d.enabled || inFlight.has(period.id)) return null;
  if (d.standups.some((s) => s.id === period.id)) return null; // already saved (edited or not): never overwritten
  if (period.kind === 'day') {
    const wd = d.workdays[period.from];
    if (wd && !wd.clockOut) return null; // the day is still open
  }
  const logs = d.logs.filter((l) => l.date >= period.from && l.date <= period.to);
  if (logs.length === 0) return null;
  inFlight.add(period.id);
  try {
    const context = standupContext({
      logs: d.logs,
      tasks: d.backlog,
      from: period.from,
      to: period.to,
      dayStandups: period.kind === 'week' ? d.standups : undefined,
    });
    const r = await (d.writer ?? chainWriter)({ logs, period, context, settings: d.settings });
    if (typeof localStorage !== 'undefined') recordAiResult(localStorage, r.writer, r.notice);
    const rec: StandupRecord = {
      id: period.id,
      kind: period.kind,
      from: period.from,
      to: period.to,
      text: r.text,
      writer: r.writer,
      ...(r.notice ? { notice: r.notice } : {}),
      createdAt: (d.now ?? (() => new Date().toISOString()))(),
    };
    // Re-check inside the update: an edit or another write that landed while the AI worked wins.
    d.setStandups((prev) => {
      if (prev.some((s) => s.id === rec.id)) return prev;
      return upsertStandup(prev, rec);
    });
    return rec;
  } finally {
    inFlight.delete(period.id);
  }
}

/**
 * Writes a standup again with the AI, when it was first written with the plain template (the AI was not available then) and
 * the person has not edited it. Returns true when an AI writer did it; false when the AI is still not available.
 */
export async function rewriteStandup(d: StandupDeps, period: StandupPeriod): Promise<boolean> {
  const current = d.standups.find((s) => s.id === period.id);
  if (!current || !needsRewrite(current)) return false;
  const logs = d.logs.filter((l) => l.date >= period.from && l.date <= period.to);
  if (logs.length === 0) return false;
  const context = standupContext({ logs: d.logs, tasks: d.backlog, from: period.from, to: period.to, dayStandups: period.kind === 'week' ? d.standups : undefined });
  const r = await (d.writer ?? chainWriter)({ logs, period, context, settings: d.settings });
  if (typeof localStorage !== 'undefined') recordAiResult(localStorage, r.writer, r.notice);
  const writer = r.writer;
  if (writer === 'template') return false;
  d.setStandups((prev) => applyRewrite(prev, period.id, r.text, writer));
  return true;
}

export function useStandups(d: StandupDeps) {
  const latest = useRef(d);
  latest.current = d;
  const inFlight = useRef(new Set<string>());
  const ensureStandup = useCallback((date: string) => writeStandupOnce(latest.current, dayPeriod(date), inFlight.current), []);
  const ensureWeekStandup = useCallback((thursday: string) => writeStandupOnce(latest.current, weekPeriod(thursday), inFlight.current), []);
  const rewrite = useCallback((date: string) => rewriteStandup(latest.current, dayPeriod(date)), []);
  return { ensureStandup, ensureWeekStandup, rewrite };
}
