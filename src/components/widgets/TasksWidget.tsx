import React, { useState } from 'react';
import { ExternalLink, Pause, Play, X } from 'lucide-react';
import { desktopBridge } from '../../utils/desktopBridge';
import { formatHms } from '../../utils/workday';
import { isSnapshotStale, type WidgetCommand, type WidgetSnapshot, type WidgetTask } from '../../utils/widgets';
import { useNow } from '../v2/useNow';

const send = (c: WidgetCommand) => desktopBridge()?.command(c);

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color || 'var(--text-muted)' }} />
);

const BTN =
  'wg-btn inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-[var(--radius-btn)] border border-[var(--border-control)] px-2.5 text-[length:var(--fs-small)] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-subtle)]';
const ICON_BTN =
  'wg-btn flex h-6 w-6 cursor-pointer items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-main)]';
const NOTE = 'text-[length:var(--fs-small)] text-[var(--text-muted)]';

const STATE_NOTE: Record<WidgetTask['state'], string> = { running: '', paused: 'Paused', blocked: 'Blocked', planned: '' };

// The running task with its clock, then the open tasks. Start / Pause / Resume do what the task rows do.
export const TasksWidget: React.FC<{ snap: WidgetSnapshot | null }> = ({ snap }) => {
  const now = useNow(1000);
  const running = snap?.tasks.filter((t) => t.state === 'running') ?? [];
  const open = snap?.tasks.filter((t) => t.state !== 'running') ?? [];
  const stale = !!snap && isSnapshotStale(snap, now);
  const [text, setText] = useState('');
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !snap) return;
    send({ type: 'add-task', text: text.trim() });
    setText('');
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-app)] bg-[var(--bg-surface)] text-[var(--text-main)]">
      <div className="wg flex items-center justify-between gap-2 border-b border-[var(--border-app)] px-3 py-2">
        <span className="text-[length:var(--fs-small)] font-bold uppercase tracking-[0.08em] text-[var(--text-muted)]">
          Tasks{snap ? ` · ${snap.tasks.length}` : ''}
        </span>
        {stale && <span className="text-[length:var(--fs-small)] font-semibold text-[var(--clock-over)]">Not updating</span>}
        <span className="flex items-center gap-0.5">
          <button type="button" aria-label="Open WorkPulse" title="Open WorkPulse" onClick={() => send({ type: 'open' })} className={ICON_BTN}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" aria-label="Hide this widget" title="Hide this widget" onClick={() => send({ type: 'close', kind: 'tasks' })} className={ICON_BTN}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </span>
      </div>

      <form onSubmit={add} className="wg-btn border-b border-[var(--border-app)] px-3 py-2">
        <label htmlFor="wg-add" className="sr-only">
          Add a task
        </label>
        <input
          id="wg-add"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a task (#project)"
          autoComplete="off"
          disabled={!snap}
          className="v2-input h-8 w-full px-2 text-[length:var(--fs-small)]"
        />
      </form>

      {running.map((t) => (
        <div key={t.id} className="wg flex items-center gap-3 border-b border-[var(--border-app)] bg-[var(--bg-subtle)] px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Dot color={t.color} />
              <span className="truncate text-[length:var(--fs-body)] font-semibold">{t.title}</span>
            </div>
            <div className="num mt-0.5 text-[22px] font-bold leading-none">
              {formatHms(t.seconds + (snap ? (now - snap.at) / 1000 : 0))}
            </div>
          </div>
          <button type="button" onClick={() => send({ type: 'pause', id: t.id })} className={BTN}>
            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
            Pause
          </button>
        </div>
      ))}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {!snap && <li className={`px-3 py-3 ${NOTE}`}>Waiting for WorkPulse…</li>}
        {snap && snap.tasks.length === 0 && <li className={`px-3 py-3 ${NOTE}`}>No open tasks.</li>}
        {snap && running.length === 0 && open.length > 0 && <li className={`px-3 pt-2 ${NOTE}`}>Nothing running.</li>}
        {open.map((t) => (
          <li key={t.id} className="flex items-center gap-2 border-b border-[var(--border-app)] px-3 py-2 last:border-b-0">
            <Dot color={t.color} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[length:var(--fs-body)]">{t.title}</div>
              {(STATE_NOTE[t.state] || t.project) && (
                <div className={`truncate ${NOTE}`}>{[STATE_NOTE[t.state], t.project].filter(Boolean).join(' · ')}</div>
              )}
            </div>
            {t.state === 'blocked' ? null : (
              <button type="button" onClick={() => send({ type: t.state === 'paused' ? 'resume' : 'start', id: t.id })} className={BTN}>
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                {t.state === 'paused' ? 'Resume' : 'Start'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
