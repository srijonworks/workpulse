import React, { useState } from 'react';
import { Check, ExternalLink, MoreHorizontal, Pause, Play, X } from 'lucide-react';
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

const STRIP_BTN =
  'wg-btn inline-flex h-7 cursor-pointer items-center rounded-[var(--radius-btn)] px-2 text-[length:var(--fs-small)] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-subtle)]';

// The ⋯ button of a row: it opens a strip of actions inside the row (a drop-down menu would be cut off by the small window).
const MoreButton: React.FC<{ title: string; open: boolean; onToggle(): void }> = ({ title, open, onToggle }) => (
  <button
    type="button"
    aria-label={`More actions for ${title}`}
    aria-expanded={open}
    title="More actions"
    onClick={onToggle}
    className={`${ICON_BTN} ${open ? 'text-[var(--text-main)]' : ''}`}
  >
    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
  </button>
);

// Done (unless shown on the row already), Edit, Adjust time, Back to planned and Delete, which asks once before it deletes.
const ActionStrip: React.FC<{ task: WidgetTask; withDone: boolean; onDone(): void }> = ({ task, withDone, onDone }) => {
  const [confirm, setConfirm] = useState(false);
  const act = (c: WidgetCommand) => {
    send(c);
    onDone();
  };
  if (confirm) {
    return (
      <div role="group" aria-label={`Delete ${task.title}?`} className="mt-1.5 flex flex-wrap items-center gap-1 pl-2.5">
        <span className={`${NOTE} mr-1`}>Delete this task?</span>
        <button type="button" onClick={() => act({ type: 'delete', id: task.id })} className={`${STRIP_BTN} text-danger`}>
          Delete
        </button>
        <button type="button" onClick={() => setConfirm(false)} className={STRIP_BTN}>
          Keep
        </button>
      </div>
    );
  }
  return (
    <div role="group" aria-label={`Actions for ${task.title}`} className="mt-1.5 flex flex-wrap items-center gap-1 pl-2.5">
      {withDone && (
        <button type="button" onClick={() => act({ type: 'done', id: task.id })} className={STRIP_BTN}>
          Done
        </button>
      )}
      <button type="button" onClick={() => act({ type: 'edit', id: task.id })} className={STRIP_BTN}>
        Edit
      </button>
      {task.state !== 'planned' && (
        <button type="button" onClick={() => act({ type: 'adjust', id: task.id })} className={STRIP_BTN}>
          Adjust time
        </button>
      )}
      {(task.state === 'paused' || task.state === 'blocked') && (
        <button type="button" onClick={() => act({ type: 'replan', id: task.id })} className={STRIP_BTN}>
          Back to planned
        </button>
      )}
      <button type="button" onClick={() => setConfirm(true)} className={`${STRIP_BTN} text-danger`}>
        Delete
      </button>
    </div>
  );
};

// The running task with its clock, then the open tasks. Start / Pause / Resume do what the task rows do.
export const TasksWidget: React.FC<{ snap: WidgetSnapshot | null }> = ({ snap }) => {
  const now = useNow(1000);
  const running = snap?.tasks.filter((t) => t.state === 'running') ?? [];
  const open = snap?.tasks.filter((t) => t.state !== 'running') ?? [];
  const stale = !!snap && isSnapshotStale(snap, now);
  const [text, setText] = useState('');
  const [moreId, setMoreId] = useState<string | null>(null);
  const toggle = (id: string) => setMoreId((m) => (m === id ? null : id));
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
        <div key={t.id} className="wg border-b border-[var(--border-app)] bg-[var(--bg-subtle)] px-3 py-2.5">
          {/* Two lines, then clamped; the dot and ⋯ stay on the first line. */}
          <div className="flex items-start gap-2">
            <span className="mt-[0.45em] flex">
              <Dot color={t.color} />
            </span>
            <span title={t.title} className="min-w-0 flex-1 line-clamp-2 break-words text-[length:var(--fs-body)] font-semibold leading-snug">
              {t.title}
            </span>
            <MoreButton title={t.title} open={moreId === t.id} onToggle={() => toggle(t.id)} />
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="num min-w-0 flex-1 text-[22px] font-bold leading-none">
              {formatHms(t.seconds + (snap ? (now - snap.at) / 1000 : 0))}
            </div>
            <button type="button" onClick={() => send({ type: 'pause', id: t.id })} className={BTN}>
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              Pause
            </button>
            <button type="button" onClick={() => send({ type: 'done', id: t.id })} className={BTN}>
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Done
            </button>
          </div>
          {moreId === t.id && <ActionStrip task={t} withDone={false} onDone={() => setMoreId(null)} />}
        </div>
      ))}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {!snap && <li className={`px-3 py-3 ${NOTE}`}>Waiting for WorkPulse…</li>}
        {snap && snap.tasks.length === 0 && <li className={`px-3 py-3 ${NOTE}`}>No open tasks.</li>}
        {snap && running.length === 0 && open.length > 0 && <li className={`px-3 pt-2 ${NOTE}`}>Nothing running.</li>}
        {open.map((t) => (
          <li key={t.id} className="border-b border-[var(--border-app)] px-3 py-2 last:border-b-0">
            <div className="flex items-start gap-2">
              <span className="mt-[0.45em] flex">
                <Dot color={t.color} />
              </span>
              <div className="min-w-0 flex-1">
                <div title={t.title} className="line-clamp-2 break-words text-[length:var(--fs-body)] leading-snug">
                  {t.title}
                </div>
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
              <MoreButton title={t.title} open={moreId === t.id} onToggle={() => toggle(t.id)} />
            </div>
            {moreId === t.id && <ActionStrip task={t} withDone onDone={() => setMoreId(null)} />}
          </li>
        ))}
      </ul>
    </div>
  );
};
