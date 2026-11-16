import { useEffect, useRef } from 'react';
import { HEARTBEAT_EVERY_MS, readHeartbeat, writeHeartbeat } from '../utils/heartbeat';

/**
 * Writes "alive now" every 30 s, when the window comes back, and as the page closes. Returns the beat found at
 * start (the last time the app was alive before this run), or null. Read it once: it is what a later day-close uses
 * as the end of the last day after a shutdown.
 */
export function useHeartbeat(enabled: boolean): { current: number | null } {
  const previous = useRef<number | null>(null);
  const read = useRef(false);
  if (!read.current && typeof localStorage !== 'undefined') {
    read.current = true;
    previous.current = readHeartbeat(localStorage, Date.now());
  }
  useEffect(() => {
    if (!enabled) return;
    const beat = () => void writeHeartbeat(localStorage, Date.now());
    beat();
    const id = setInterval(beat, HEARTBEAT_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') beat();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', beat);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', beat);
    };
  }, [enabled]);
  return previous;
}
