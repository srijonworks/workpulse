import { useEffect, useRef } from 'react';
import type { AppSettings, BacklogTask, Project, WorkLog, Workdays } from '../types';
import { desktopBridge } from '../utils/desktopBridge';
import { localDateStr } from '../utils/dates';
import { normalizeTheme } from '../utils/theme';
import { buildWidgetSnapshot, snapshotSignature, widgetConfig, type WidgetCommand } from '../utils/widgets';

const RESYNC_MS = 30_000;

/**
 * Desktop app only: tells the shell which widgets are on, keeps them supplied with a fresh snapshot
 * (when something they show changes, and every 30 s so a running clock stays right), and hands their
 * button presses to `onCommand`. In a browser it does nothing.
 */
export function useWidgetBridge(input: {
  settings: AppSettings;
  backlog: BacklogTask[];
  projects: Project[];
  workdays: Workdays;
  /** Today's logs are summed into the Time widget's "Logged". */
  logs: WorkLog[];
  /** Plain sentences the widgets show as a warning (empty = none). */
  problems?: string[];
  loaded: boolean;
  onCommand(c: WidgetCommand): void;
}): void {
  const { settings, backlog, projects, workdays, logs, loaded } = input;
  const problemsKey = JSON.stringify(input.problems ?? []);
  const bridge = desktopBridge();
  const cmdRef = useRef(input.onCommand);
  cmdRef.current = input.onCommand;
  const last = useRef({ sig: '', at: 0 });

  const config = widgetConfig(settings.widgets);
  const configKey = JSON.stringify(config);
  const anyOn = config.time.on || config.tasks.on;

  useEffect(() => {
    if (!bridge || !loaded) return;
    bridge.setWidgets(JSON.parse(configKey));
    last.current = { sig: '', at: 0 }; // a window that was just opened gets a snapshot at once
  }, [bridge, loaded, configKey]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onCommand((c) => cmdRef.current(c));
  }, [bridge]);

  // Runs on every render (the app re-renders each second while a timer runs); it only sends when worth it.
  useEffect(() => {
    if (!bridge || !loaded || !anyOn) return;
    const nowMs = Date.now();
    const snap = buildWidgetSnapshot({
      theme: normalizeTheme(settings.theme),
      backlog,
      projects,
      workdays,
      workdayHours: settings.workdayHours,
      today: localDateStr(),
      nowMs,
      logs,
      problems: JSON.parse(problemsKey),
    });
    const sig = snapshotSignature(snap);
    if (sig === last.current.sig && nowMs - last.current.at < RESYNC_MS) return;
    last.current = { sig, at: nowMs };
    bridge.pushState(snap);
  });
}
