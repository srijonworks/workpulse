import React from 'react';
import type { AppNavTab } from '../../types';
import { formatHm } from '../../utils/workday';

export type V2Tab = AppNavTab;

export const V2_TABS: { id: V2Tab; label: string }[] = [
  // Tab names are verbs: Do (today's work) and Plan (every task by due date). The ids stay as stored.
  { id: 'today', label: 'Do' },
  { id: 'tasks', label: 'Plan' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

interface NavTabsProps {
  active: V2Tab;
  onChange(t: V2Tab): void;
  /** Minutes logged today, shown on Today as h:mm. */
  todayMinutes: number;
  /** Open tasks, shown on Tasks. */
  openTasks: number;
}

// The four screens as plain buttons in a nav (not an ARIA tablist): the current one has aria-current.
export const NavTabs: React.FC<NavTabsProps> = ({ active, onChange, todayMinutes, openTasks }) => {
  const badge = (id: V2Tab) => {
    if (id === 'today' && todayMinutes > 0) {
      return { value: formatHm(todayMinutes * 60), sr: ' logged' };
    }
    if (id === 'tasks' && openTasks > 0) return { value: String(openTasks), sr: ' open' };
    return null;
  };

  return (
    <nav aria-label="Main">
      <ul className="flex items-center gap-1">
        {V2_TABS.map(({ id, label }) => {
          const b = badge(id);
          return (
            <li key={id}>
              <button
                type="button"
                aria-current={active === id ? 'page' : undefined}
                onClick={() => onChange(id)}
                className="v2-tab flex items-center gap-2 h-10 px-3 lg:px-3.5 rounded-[var(--radius-btn)] text-[length:var(--fs-body)] font-semibold whitespace-nowrap cursor-pointer transition-colors"
              >
                {label}
                {b && (
                  <span className="num font-semibold text-[var(--accent)]">
                    <span className="sr-only">, </span>
                    {b.value}
                    <span className="sr-only">{b.sr}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};
