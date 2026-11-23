import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, BacklogTask, Project, WorkLog, Workdays } from '../types';
import { buildSnapshot, mergeInbox, snapshotSignature, type InboxItem, type PhoneClockOut } from '../utils/phoneSync';
import { ackInbox, pullInbox, pushState, type PhoneApiResult } from '../utils/phoneApi';
import { ensureDeviceId } from '../utils/phoneSettings';
import { isRunningTask, sameTasksIgnoringLiveTime } from '../utils/timerStore';

// Keeps the phone page and the evening email up to date (push) and takes the tasks added on the
// phone (pull). Active only when a Sheet URL and the desktop token are set. Failures are quiet: they
// are written to settings.phoneLastError for Settings to show, and the next cycle tries again.

export const PUSH_DEBOUNCE_MS = 5_000;
export const RUNNING_PUSH_MS = 5 * 60_000;
export const PULL_EVERY_MS = 60_000;
const FOCUS_PULL_GAP_MS = 10_000;

const SAVE_FAILED = 'Could not save the phone tasks on this computer. They stay waiting in the Sheet.';
const PULL_FAILED = 'Could not add the phone tasks just now. They stay waiting in the Sheet.';
const CLOCK_OUT_SAVE_FAILED = 'Could not save the clock-out from your phone on this computer. It stays waiting in the Sheet.';

/** Push when what the phone shows changed, or every 5 minutes while a timer runs (tracked minutes move). */
export function shouldPush(i: {
  signature: string;
  lastSignature: string | null;
  lastPushAtMs: number | null;
  nowMs: number;
  running: boolean;
}): boolean {
  if (i.signature !== i.lastSignature) return true;
  return i.running && i.lastPushAtMs !== null && i.nowMs - i.lastPushAtMs >= RUNNING_PUSH_MS;
}

export interface PullDeps {
  pull(): Promise<PhoneApiResult<{ items?: InboxItem[]; clockOuts?: PhoneClockOut[] }>>;
  merge(items: InboxItem[]): { backlog: BacklogTask[]; added: BacklogTask[]; takenIds: string[] };
  /** True only when the merged tasks are safely stored. */
  save(next: BacklogTask[]): boolean;
  /**
   * Applies the phone's clock-outs and stores the workdays (see applyPhoneClockOuts). Null when they could not be stored:
   * nothing is acknowledged, so they stay waiting in the Sheet. Absent = clock-outs are left alone.
   */
  applyClockOuts?(items: PhoneClockOut[]): { applied: PhoneClockOut[]; handledIds: string[] } | null;
  /** `clockOutIds` is passed only when there are some. */
  ack(ids: string[], clockOutIds?: string[]): Promise<PhoneApiResult>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// Whatever the Sheet sent, as clean inbox items; an item without an id is skipped, odd fields become ''.
function cleanItems(raw: unknown): InboxItem[] {
  if (!Array.isArray(raw)) return [];
  const out: InboxItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    const due = text(o.dueDate);
    out.push({
      id: o.id,
      title: text(o.title),
      projectId: text(o.projectId),
      projectName: text(o.projectName),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '',
      createdAt: text(o.createdAt),
    });
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}T/;

// The phone clock-outs the Sheet sent, cleaned the same way; one with a missing date or time is skipped (never acknowledged).
function cleanClockOuts(raw: unknown): PhoneClockOut[] {
  if (!Array.isArray(raw)) return [];
  const out: PhoneClockOut[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const date = text(o.date);
    const clockIn = text(o.clockIn);
    const clockOut = text(o.clockOut);
    if (typeof o.id !== 'string' || !o.id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !ISO.test(clockIn) || !ISO.test(clockOut)) continue;
    out.push({ id: o.id, date, clockIn, clockOut });
  }
  return out;
}

export interface PullResult {
  /** Tasks the phone added. */
  added: BacklogTask[];
  /** Phone clock-outs that closed a day on this computer. */
  clockedOut?: PhoneClockOut[];
  error?: string;
}

/**
 * One pull: read the inbox, merge, save, and only after a successful save mark the items taken.
 * If the ack fails the tasks stay here and the next pull skips them (their ids already exist).
 * Phone clock-outs go the same way: applied and stored first, then acknowledged.
 */
export async function pullAndMerge(deps: PullDeps): Promise<PullResult> {
  const r = await deps.pull();
  if (!r.ok) return { added: [], error: r.message };
  const items = cleanItems(r.data?.items);
  const outs = deps.applyClockOuts ? cleanClockOuts(r.data?.clockOuts) : [];
  if (items.length === 0 && outs.length === 0) return { added: [] };

  let added: BacklogTask[] = [];
  let takenIds: string[] = [];
  if (items.length > 0) {
    const merged = deps.merge(items);
    if (!deps.save(merged.backlog)) return { added: [], error: SAVE_FAILED };
    added = merged.added;
    takenIds = merged.takenIds;
  }

  const result: PullResult = { added };
  let outIds: string[] = [];
  if (outs.length > 0) {
    const applied = deps.applyClockOuts!(outs);
    if (applied) {
      outIds = applied.handledIds;
      if (applied.applied.length > 0) result.clockedOut = applied.applied;
    } else {
      result.error = CLOCK_OUT_SAVE_FAILED;
    }
  }

  if (takenIds.length > 0 || outIds.length > 0) {
    const a = outIds.length > 0 ? await deps.ack(takenIds, outIds) : await deps.ack(takenIds);
    if (!a.ok) result.error = a.message;
  }
  return result;
}

/** Waits before the quick retries after a failed push (10 s, 10 s, 20 s, 40 s); after them the minute cycle goes on. */
export const PUSH_RETRY_MS = [10_000, 10_000, 20_000, 40_000];

/** The wait before retry number `failures` (1 = after the first failure), or null when the quick retries are used up. */
export function pushRetryDelay(failures: number): number | null {
  return failures >= 1 && failures <= PUSH_RETRY_MS.length ? PUSH_RETRY_MS[failures - 1] : null;
}

/**
 * True when `next` has a clock-out that `prev` did not have (or a different one): the Sheet must hear of it at once, because
 * it sends the day's email from it and the PC may be shut down right after. `prev` null (first look) is never new.
 */
export function newClockOut(prev: Workdays | null, next: Workdays): boolean {
  if (!prev) return false;
  return Object.keys(next).some((d) => !!next[d]?.clockOut && next[d].clockOut !== prev[d]?.clockOut);
}

/** What Settings shows: a failing push wins (the phone's view is getting old), else a failing pull. */
export function combinedError(e: { push?: string; pull?: string }): string | undefined {
  return e.push ?? e.pull;
}

export interface PhoneSyncStatus {
  /** ISO time of the last successful push from this computer. */
  lastPushAt?: string;
  lastError?: string;
  busy: boolean;
  /** The latest push found that another computer pushed before it. */
  deviceChanged: boolean;
}

export interface PhoneSyncArgs {
  /** False until the stored data has loaded: nothing is pushed or pulled before that. */
  enabled: boolean;
  settings: AppSettings;
  /** Writes only these fields onto the latest settings. */
  updateSettings(patch: Partial<AppSettings>): void;
  backlog: BacklogTask[];
  logs: WorkLog[];
  projects: Project[];
  workdays: Workdays;
  today: string;
  /** Adds the new tasks in `next` to the current backlog and saves; true only when the save worked. */
  mergeAndSaveBacklog(next: BacklogTask[]): boolean;
  onTasksAdded(added: BacklogTask[]): void;
  /** Applies the phone's clock-outs to the newest workdays and saves them (null when the save failed). */
  applyPhoneClockOuts(items: PhoneClockOut[]): { applied: PhoneClockOut[]; handledIds: string[] } | null;
}

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const snapshotOf = (a: PhoneSyncArgs, deviceId: string) =>
  buildSnapshot({
    backlog: a.backlog,
    logs: a.logs,
    projects: a.projects,
    workdays: a.workdays,
    workdayHours: a.settings.workdayHours,
    tz: zone(),
    deviceId,
    today: a.today,
    phoneClockOut: a.settings.phoneClockOutEnabled,
  });

export function usePhoneSync(args: PhoneSyncArgs): {
  syncNow(): Promise<void>;
  pullNow(): Promise<BacklogTask[]>;
  /** Pushes now if anything changed; true when the Sheet then has the current state (the shell's last push before shutdown). */
  pushNow(): Promise<boolean>;
  /** The Sheet is behind this computer (a change not pushed yet, or a push that failed). */
  pending: boolean;
  /** The last push failed (cleared by the next one that works). */
  pushFailed: boolean;
  /** A Sheet link and token are set, so this computer pushes to the Sheet. */
  linked: boolean;
  status: PhoneSyncStatus;
} {
  const latest = useRef(args);
  latest.current = args;
  const { settings } = args;
  const url = settings.googleScriptUrl || '';
  const token = settings.phoneToken || '';
  const active = Boolean(args.enabled && url && token);

  const [busy, setBusy] = useState(false);
  const [deviceChanged, setDeviceChanged] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  const lastSig = useRef<string | null>(null);
  // The same as lastSig, as state, so `pending` follows a push.
  const [pushedSig, setPushedSig] = useState<string | null>(null);
  const [pushFailed, setPushFailed] = useState(false);
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushRef = useRef<() => Promise<void>>(async () => undefined);
  const lastPushAt = useRef<number | null>(null);
  const lastPullAt = useRef(0);
  const errors = useRef<{ push?: string; pull?: string }>({});

  // The signature only changes when the phone's view does; computing it is skipped while only the
  // running timers' seconds move (App re-renders every second then).
  const sigCache = useRef<{ a: PhoneSyncArgs; sig: string } | null>(null);
  let signature = '';
  if (active) {
    const c = sigCache.current?.a;
    if (
      c &&
      c.logs === args.logs &&
      c.projects === args.projects &&
      c.workdays === args.workdays &&
      c.today === args.today &&
      c.settings.workdayHours === settings.workdayHours &&
      c.settings.phoneClockOutEnabled === settings.phoneClockOutEnabled &&
      sameTasksIgnoringLiveTime(c.backlog, args.backlog)
    ) {
      signature = sigCache.current!.sig;
    } else {
      signature = snapshotSignature(snapshotOf(args, ''));
      sigCache.current = { a: args, sig: signature };
    }
  }

  // Writes status fields into settings, only when they change. The ref is updated at once, so two
  // writes before the next render do not undo each other.
  const record = useCallback((patch: Partial<AppSettings>) => {
    const s = latest.current.settings;
    if ((Object.keys(patch) as (keyof AppSettings)[]).every((k) => s[k] === patch[k])) return;
    latest.current = { ...latest.current, settings: { ...s, ...patch } };
    latest.current.updateSettings(patch);
  }, []);

  // A push result clears or sets only the push error, a pull result only the pull error.
  const setError = useCallback(
    (kind: 'push' | 'pull', message: string | undefined) => {
      errors.current = { ...errors.current, [kind]: message };
      record({ phoneLastError: combinedError(errors.current) });
    },
    [record],
  );

  // One pull or push in flight at a time.
  const run = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    inFlight.current += 1;
    setBusy(true);
    const p = queue.current.then(job).finally(() => {
      inFlight.current -= 1;
      if (inFlight.current === 0) setBusy(false);
    });
    queue.current = p.catch(() => undefined);
    return p;
  }, []);

  const push = useCallback(
    () =>
      run(async () => {
        let s = latest.current.settings;
        if (!s.googleScriptUrl || !s.phoneToken) return;
        if (!s.phoneDeviceId) {
          s = ensureDeviceId(s);
          record({ phoneDeviceId: s.phoneDeviceId });
        }
        const a = latest.current;
        const snap = snapshotOf(a, s.phoneDeviceId as string);
        // The signature ignores the device id, so it matches the one computed at render.
        const sig = snapshotSignature(snap);
        const nowMs = Date.now();
        const running = a.backlog.some(isRunningTask);
        if (!shouldPush({ signature: sig, lastSignature: lastSig.current, lastPushAtMs: lastPushAt.current, nowMs, running })) return;
        const r = await pushState(s.googleScriptUrl, s.phoneToken as string, snap);
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = null;
        if (r.ok) {
          lastSig.current = sig;
          setPushedSig(sig);
          lastPushAt.current = nowMs;
          failures.current = 0;
          setPushFailed(false);
          setDeviceChanged((r.data as { deviceChanged?: unknown } | undefined)?.deviceChanged === true);
          record({ phoneSyncAt: new Date(nowMs).toISOString() });
          setError('push', undefined);
        } else {
          setPushFailed(true);
          setError('push', r.message);
          // Try again soon (a clock-out must reach the Sheet before the PC goes off), then fall back to the minute cycle.
          failures.current += 1;
          const wait = pushRetryDelay(failures.current);
          if (wait !== null) retryTimer.current = setTimeout(() => void pushRef.current(), wait);
        }
      }),
    [run, record, setError],
  );
  pushRef.current = push;
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  const pull = useCallback(
    (): Promise<BacklogTask[]> =>
      run(async () => {
        const s = latest.current.settings;
        const scriptUrl = s.googleScriptUrl || '';
        const tok = s.phoneToken || '';
        if (!scriptUrl || !tok) return [];
        lastPullAt.current = Date.now();
        let out: PullResult;
        try {
          out = await pullAndMerge({
            pull: () => pullInbox(scriptUrl, tok),
            merge: (items) => {
              const a = latest.current;
              return mergeInbox(a.backlog, a.projects, items, a.today);
            },
            save: (next) => latest.current.mergeAndSaveBacklog(next),
            applyClockOuts: (items) => latest.current.applyPhoneClockOuts(items),
            ack: (ids, clockOutIds) => ackInbox(scriptUrl, tok, ids, clockOutIds),
          });
        } catch {
          out = { added: [], error: PULL_FAILED };
        }
        setError('pull', out.error);
        if (out.added.length > 0) latest.current.onTasksAdded(out.added);
        return out.added;
      }),
    [run, setError],
  );

  // A new script or token: push the full state again.
  useEffect(() => {
    lastSig.current = null;
    setPushedSig(null);
    setPushFailed(false);
    failures.current = 0;
    lastPushAt.current = null;
    errors.current = {};
  }, [url, token]);

  // A new clock-out goes to the Sheet at once, not after the usual few seconds: the Sheet sends the day's email from it.
  const seenWorkdays = useRef<Workdays | null>(null);
  useEffect(() => {
    if (!active) {
      seenWorkdays.current = null;
      return;
    }
    if (newClockOut(seenWorkdays.current, args.workdays)) void push();
    seenWorkdays.current = args.workdays;
  }, [active, args.workdays, push]);

  // Pull once at load (or when the link is first set up).
  useEffect(() => {
    if (active) void pull();
  }, [active, pull]);

  // Push a few seconds after the phone's view changes.
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => void push(), PUSH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [active, signature, push]);

  // Every minute: pull while the page is visible, and push if due (a running timer every 5 minutes).
  // Pull again when the window gets focus.
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (inFlight.current > 0) return;
      if (document.visibilityState === 'visible') void pull();
      void push();
    };
    const onFocus = () => {
      if (inFlight.current > 0 || Date.now() - lastPullAt.current < FOCUS_PULL_GAP_MS) return;
      void pull();
    };
    const id = setInterval(tick, PULL_EVERY_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, pull, push]);

  const syncNow = useCallback(async () => {
    lastSig.current = null;
    await push();
    await pull();
  }, [push, pull]);

  const pushNow = useCallback(async () => {
    const s = latest.current.settings;
    if (!latest.current.enabled || !s.googleScriptUrl || !s.phoneToken) return true;
    await push();
    const a = latest.current;
    return snapshotSignature(snapshotOf(a, '')) === lastSig.current;
  }, [push]);

  return {
    syncNow,
    pullNow: pull,
    pushNow,
    pending: active && signature !== pushedSig,
    pushFailed: active && pushFailed,
    linked: active,
    status: { lastPushAt: settings.phoneSyncAt, lastError: settings.phoneLastError, busy, deviceChanged },
  };
}
