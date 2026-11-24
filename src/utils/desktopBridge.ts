import type { WidgetCommand, WidgetConfig, WidgetSnapshot } from './widgets';

// The Electron shell's preload script exposes this on `window` (electron/preload.cjs). In a normal browser it is absent.
export interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error' | 'unavailable';
  /** The version running now. */
  version: string;
  newVersion?: string;
  percent?: number;
  checkedAt?: number;
  message?: string;
}

export interface DesktopBridge {
  isDesktop: true;
  pushState(s: WidgetSnapshot): void;
  setWidgets(c: WidgetConfig): void;
  onState(cb: (s: WidgetSnapshot) => void): () => void;
  command(c: WidgetCommand): void;
  onCommand(cb: (c: WidgetCommand) => void): () => void;
  getUpdateState(): Promise<UpdateState | null>;
  checkForUpdates(): void;
  installUpdate(): void;
  onUpdateState(cb: (s: UpdateState) => void): () => void;
  /** The shell asks the page to save everything now (quit, sleep, lock, sign-out); call `flushed` when done. */
  onFlush(cb: () => void): () => void;
  flushed(): void;
  /** Tells the shell whether the Sheet is behind this computer, so a Windows shutdown waits for one last push. */
  setSheetPending(pending: boolean): void;
  /** Windows is shutting down and the Sheet is behind: push now, then call `finalPushed` (the shell waits a few seconds at most). */
  onFinalPush(cb: () => void): () => void;
  finalPushed(): void;
  /** Seconds since the last keyboard or mouse input anywhere on the PC; null when unknown. Absent in an older shell. */
  getIdleSeconds?(): Promise<number | null>;
}

export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { workpulseDesktop?: DesktopBridge }).workpulseDesktop ?? null;
}
