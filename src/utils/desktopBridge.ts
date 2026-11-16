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
}

export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { workpulseDesktop?: DesktopBridge }).workpulseDesktop ?? null;
}
