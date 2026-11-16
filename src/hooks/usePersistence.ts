import { useEffect, useSyncExternalStore } from 'react';
import { getEngine } from '../utils/storage';
import type { EngineStatus } from '../utils/persist/engine';
import { acquireWriterLock, type WriterLock } from '../utils/persist/writerLock';

// Keeps the save engine working while the app runs: a save that failed is tried again every few seconds and
// whenever the window comes back, and only one window at a time is allowed to write. The screen shows the state
// (SaveStatusBanner); nothing here is silent.

const RETRY_EVERY_MS = 10_000;
const STEAL_KEY = 'workpulse_use_this_window';

/** The engine's state, for the screen. It changes only when something does. */
export function usePersistenceStatus(): EngineStatus {
  return useSyncExternalStore(
    (onChange) => getEngine().subscribe(onChange),
    () => getEngine().status(),
  );
}

const readSteal = (): boolean => {
  try {
    const v = sessionStorage.getItem(STEAL_KEY) === '1';
    sessionStorage.removeItem(STEAL_KEY);
    return v;
  } catch {
    return false;
  }
};

/** "Use this window": the next load takes the writer lock over (the other window becomes read-only). */
export function useThisWindow(): void {
  try {
    sessionStorage.setItem(STEAL_KEY, '1');
  } catch {
    // the reload below still works; it just may find the lock busy
  }
  window.location.reload();
}

export function usePersistence(enabled: boolean): void {
  // Retry what could not be written.
  useEffect(() => {
    if (!enabled) return;
    const tryAgain = () => {
      const engine = getEngine();
      const s = engine.status();
      if (s.notSaved && !s.frozen) engine.retry();
    };
    const id = setInterval(tryAgain, RETRY_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tryAgain();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tryAgain);
    window.addEventListener('pagehide', tryAgain); // one last try while the page is closing
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tryAgain);
      window.removeEventListener('pagehide', tryAgain);
    };
  }, [enabled]);

  // Only one window writes.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let lock: WriterLock | null = null;
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    void acquireWriterLock(locks, {
      steal: readSteal(),
      retries: 3,
      retryMs: 200,
      onLost: () => getEngine().freeze(),
    }).then((l) => {
      if (cancelled) {
        l.release();
        return;
      }
      lock = l;
      if (l.state === 'taken-elsewhere') getEngine().freeze();
    });
    return () => {
      cancelled = true;
      lock?.release();
    };
  }, [enabled]);
}
