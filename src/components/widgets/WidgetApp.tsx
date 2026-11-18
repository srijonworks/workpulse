import React, { useEffect, useState } from 'react';
import { desktopBridge } from '../../utils/desktopBridge';
import { normalizeTheme } from '../../utils/theme';
import type { WidgetKind, WidgetSnapshot } from '../../utils/widgets';
import { TimeWidget } from './TimeWidget';
import { TasksWidget } from './TasksWidget';

// The page the desktop widget windows show (`/?widget=time|tasks`). It only reads: the main window owns the
// data and sends snapshots; nothing here writes to localStorage.
export const WidgetApp: React.FC<{ kind: WidgetKind }> = ({ kind }) => {
  const [snap, setSnap] = useState<WidgetSnapshot | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-widget', kind);
    return desktopBridge()?.onState(setSnap);
  }, [kind]);

  useEffect(() => {
    if (!snap) return;
    const theme = normalizeTheme(snap.theme);
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-mode', theme === 'console' || theme === 'nightdesk' ? 'dark' : 'light');
  }, [snap]);

  return kind === 'time' ? <TimeWidget snap={snap} /> : <TasksWidget snap={snap} />;
};
