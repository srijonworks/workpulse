import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getEngine } from '../utils/storage';
import { requestJson } from '../utils/net/http';
import { createDiskMirror, type Mirror, type MirrorState } from '../utils/persist/diskMirror';
import { decide, hasRealStoredData } from '../utils/persist/reconcile';
import { countsOf, type CopyCounts, type CopyFile } from '../utils/persist/copyFormat';
import { DATA_KEYS, type DataKey } from '../utils/persist/keys';

// Keeps a copy of the data on this computer's disk (the local server writes it) and brings it back when the browser's
// storage was wiped or a list could not be read. The page decides; the server only stores and reads files.

const COPY_URL = '/api/disk-copy';
// A browser lets a request that outlives the page carry at most 64 KB.
const KEEPALIVE_LIMIT = 60_000;

export interface RestoreOffer {
  reason: 'empty' | 'behind' | 'blocked';
  savedAt: string;
  counts: CopyCounts;
  /** Keys to bring back; all of the copy's keys unless only some could not be read. */
  keys: DataKey[];
}

const readRaw = (): Partial<Record<DataKey, string | null>> => {
  const out: Partial<Record<DataKey, string | null>> = {};
  for (const k of DATA_KEYS) {
    try {
      out[k] = localStorage.getItem(k);
    } catch {
      out[k] = null;
    }
  }
  return out;
};

let sharedMirror: Mirror | null = null;
let mirrorState: MirrorState = { kind: 'idle' };
const stateListeners = new Set<() => void>();
const getMirror = (readyRef: { current: boolean }): Mirror => {
  if (!sharedMirror) {
    sharedMirror = createDiskMirror({
      engine: getEngine(),
      readRaw,
      ready: () => readyRef.current,
      hasRealData: () => hasRealStoredData(readRaw()),
      onState: (s) => {
        mirrorState = s;
        for (const fn of [...stateListeners]) fn();
      },
      send: (body, o) => requestJson(COPY_URL, { method: 'PUT', body, timeoutMs: o.timeoutMs, keepalive: o.keepalive && JSON.stringify(body).length < KEEPALIVE_LIMIT }),
    });
  }
  return sharedMirror;
};

/** The state of the disk copy, for the screen. */
export const useDiskCopyState = (): MirrorState =>
  useSyncExternalStore(
    (fn) => (stateListeners.add(fn), () => stateListeners.delete(fn)),
    () => mirrorState,
  );

/** Keeps what is stored now before something replaces it (import, reset). Quiet when it cannot: the rolling copy still exists. */
export function saveSafetyCopy(reason: string): void {
  const keys = Object.fromEntries(Object.entries(readRaw()).filter(([, v]) => typeof v === 'string'));
  if (Object.keys(keys).length === 0) return;
  const body = { keys, reason, profileId: getEngine().status().profileId };
  void requestJson(`${COPY_URL}/safety`, { method: 'POST', body, timeoutMs: 10_000, keepalive: JSON.stringify(body).length < KEEPALIVE_LIMIT });
}

export interface DiskCopyApi {
  offer: RestoreOffer | null;
  /** Brings the copy back and reloads. Returns a plain sentence when it could not. */
  restore: () => Promise<string | null>;
  /** The user keeps what is in this browser; the copy is replaced from now on (the old one is kept as a safety copy). */
  keepThisBrowser: () => void;
}

export function useDiskCopy(enabled: boolean, beforeReload: () => void): DiskCopyApi {
  const [offer, setOffer] = useState<RestoreOffer | null>(null);
  const copyRef = useRef<CopyFile | null>(null);
  const readyRef = useRef(false);
  const mirrorRef = useRef<Mirror | null>(null);

  // The start-up check, then the mirror.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const mirror = getMirror(readyRef);
    mirrorRef.current = mirror;
    const stop = mirror.start();
    const onHide = () => {
      if (document.visibilityState === 'hidden') void mirror.flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);

    void (async () => {
      const r = await requestJson<{ copy: CopyFile | null }>(COPY_URL, { timeoutMs: 15_000 });
      if (cancelled) return;
      if (!r.ok || !r.data.copy) {
        readyRef.current = true; // no server answer or no copy yet: nothing to reconcile, start copying
        return;
      }
      const copy = r.data.copy;
      copyRef.current = copy;
      const status = getEngine().status();
      const d = decide({ profileId: status.profileId, rev: status.rev, raw: readRaw(), blockedKeys: status.blockedKeys }, copy, copy.keys);
      if (d.action === 'offer-restore') {
        setOffer({ reason: d.reason, savedAt: copy.savedAt, counts: copy.counts, keys: Object.keys(copy.keys) as DataKey[] });
        return; // the mirror stays quiet until the user chooses
      }
      if (d.action === 'restore-keys') {
        setOffer({ reason: 'blocked', savedAt: copy.savedAt, counts: countsOf(copy.keys), keys: d.keys });
        return;
      }
      if (d.action === 'take-over') mirror.allowTakeOver();
      readyRef.current = true;
    })();

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [enabled]);

  const restore = useCallback(async (): Promise<string | null> => {
    const copy = copyRef.current;
    if (!offer || !copy) return 'There is no copy to bring back.';
    // What is here now is kept first, so a restore can always be undone.
    const safe = await requestJson(`${COPY_URL}/safety`, {
      method: 'POST',
      timeoutMs: 15_000,
      body: { keys: Object.fromEntries(Object.entries(readRaw()).filter(([, v]) => typeof v === 'string')), reason: 'before-restore', profileId: getEngine().status().profileId },
    });
    // A browser with nothing in it has nothing to keep; a refusal for "nothing to copy" is fine, a disk problem is not.
    if (!safe.ok && !(safe.status === 400)) return 'WorkPulse could not keep a copy of what is here first, so nothing was restored. Try again.';
    try {
      for (const k of offer.keys) {
        const text = copy.keys[k];
        if (typeof text !== 'string') continue;
        localStorage.setItem(k, text);
        getEngine().unblock(k, { discardPending: true });
      }
    } catch {
      return 'This browser did not accept the data (no room or blocked). Nothing was restored.';
    }
    beforeReload();
    window.location.reload();
    return null;
  }, [offer, beforeReload]);

  const keepThisBrowser = useCallback(() => {
    setOffer(null);
    readyRef.current = true;
    mirrorRef.current?.allowTakeOver();
  }, []);

  return { offer, restore, keepThisBrowser };
}
