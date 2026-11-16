import { BACKOFF, nextDelay } from '../net/backoff';
import type { NetResult } from '../net/http';
import type { Engine } from './engine';
import { DATA_KEYS, type DataKey } from './keys';

// Keeps the copy of the data on this computer's disk up to date. It watches the save engine: when the save counter
// moves, the raw stored text of the data keys is sent to the local server, a few seconds later and never more often
// than every 15 seconds. It never decides anything about the data itself, only copies it. Pure: the network, storage
// and timers are passed in.

const DEBOUNCE_MS = 3_000;
const MIN_GAP_MS = 15_000;
const SEND_TIMEOUT_MS = 20_000;

export type MirrorState =
  | { kind: 'idle' }
  | { kind: 'ok'; at: number; rev: number }
  /** The copy on disk belongs to another browser profile; nothing is sent until the user (or the page) says so. */
  | { kind: 'conflict' }
  | { kind: 'failing'; message: string; since: number }
  /** Not sending for now (no real data yet, a list is unreadable, the window is read-only). */
  | { kind: 'paused'; why: string };

export interface MirrorDeps {
  engine: Pick<Engine, 'status' | 'subscribe'>;
  /** The stored text of every data key. */
  readRaw: () => Partial<Record<DataKey, string | null>>;
  send: (body: { profileId: string; rev: number; keys: Partial<Record<DataKey, string>>; takeover: boolean }, o: { keepalive: boolean; timeoutMs: number }) => Promise<NetResult<unknown>>;
  /** False until the page has decided about the copy on disk (see reconcile): nothing is sent before that. */
  ready: () => boolean;
  /** Whether this browser holds data worth copying (the demo data alone is not). */
  hasRealData: () => boolean;
  onState?: (s: MirrorState) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface Mirror {
  start(): () => void;
  /** Sends at once if something changed (quit, suspend, hidden page). */
  flush(): Promise<void>;
  /** The user (or the page) chose this browser's data over the copy of another profile. */
  allowTakeOver(): void;
  state(): MirrorState;
}

export function createDiskMirror(d: MirrorDeps): Mirror {
  const now = d.now ?? Date.now;
  const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let state: MirrorState = { kind: 'idle' };
  let sentRev = -1;
  let lastSendAt = -Infinity;
  let timer: unknown = null;
  let inFlight = false;
  let failures = 0;
  let takeover = false;
  let failingSince = 0;

  const set = (s: MirrorState) => {
    state = s;
    d.onState?.(s);
  };

  const collect = (): Partial<Record<DataKey, string>> => {
    const raw = d.readRaw();
    const out: Partial<Record<DataKey, string>> = {};
    for (const k of DATA_KEYS) if (typeof raw[k] === 'string') out[k] = raw[k] as string;
    return out;
  };

  const pausedWhy = (): string | null => {
    const s = d.engine.status();
    if (!d.ready()) return 'waiting for the start-up check';
    if (s.frozen) return 'this window is read-only';
    if (s.blockedKeys.length > 0) return 'part of the data could not be read';
    if (!d.hasRealData()) return 'nothing to copy yet';
    return null;
  };

  const schedule = (ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void attempt(false);
    }, ms);
  };

  async function attempt(keepalive: boolean): Promise<void> {
    if (inFlight || state.kind === 'conflict') return;
    const why = pausedWhy();
    if (why) {
      set({ kind: 'paused', why });
      if (!d.ready()) schedule(DEBOUNCE_MS); // the start-up check is still running: look again soon
      return;
    }
    const status = d.engine.status();
    if (status.rev === sentRev && failures === 0) return;
    const wait = lastSendAt + MIN_GAP_MS - now();
    if (!keepalive && wait > 0) {
      schedule(wait);
      return;
    }
    inFlight = true;
    lastSendAt = now();
    const sendingRev = status.rev;
    let r: NetResult<unknown>;
    try {
      r = await d.send({ profileId: status.profileId, rev: sendingRev, keys: collect(), takeover }, { keepalive, timeoutMs: SEND_TIMEOUT_MS });
    } finally {
      inFlight = false;
    }
    if (r.ok) {
      failures = 0;
      sentRev = sendingRev;
      takeover = false;
      set({ kind: 'ok', at: now(), rev: sendingRev });
    } else if (r.status === 409) {
      const code = (r.data as { code?: string } | undefined)?.code;
      if (code === 'other-profile') {
        set({ kind: 'conflict' });
        return;
      }
      // "stale": the copy on disk is already newer than this page. Wait for the next change (the start-up check handles it).
      sentRev = sendingRev;
      set({ kind: 'paused', why: 'the copy on disk is newer' });
    } else {
      if (failures === 0) failingSince = now();
      failures++;
      const message = (r.data as { message?: string } | undefined)?.message ?? r.message;
      set({ kind: 'failing', message, since: failingSince });
      schedule(nextDelay(failures, BACKOFF.diskCopy));
      return;
    }
    // Something changed while this request was going.
    if (d.engine.status().rev !== sentRev) schedule(DEBOUNCE_MS);
  }

  return {
    start() {
      let lastSeenRev = d.engine.status().rev;
      const off = d.engine.subscribe(() => {
        const rev = d.engine.status().rev;
        if (rev === lastSeenRev) return;
        lastSeenRev = rev;
        if (timer === null) schedule(DEBOUNCE_MS);
      });
      // The page just started: copy what is there once the start-up check is done.
      schedule(DEBOUNCE_MS);
      return () => {
        off();
        if (timer !== null) clearTimer(timer);
        timer = null;
      };
    },
    async flush() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      await attempt(true);
    },
    allowTakeOver() {
      takeover = true;
      if (state.kind === 'conflict') set({ kind: 'idle' });
      schedule(0);
    },
    state: () => state,
  };
}
