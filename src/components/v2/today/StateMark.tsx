import React from 'react';

export type TaskState = 'running' | 'paused' | 'blocked' | 'upnext' | 'done';

/**
 * The shape that says a task's state, so colour is never the only signal: filled dot (running, pulses
 * unless motion is reduced), two bars (paused), circle with a cross (blocked), hollow dot (up next /
 * planned), check (done). Decorative: the heading or the row's meta line carries the words.
 */
export const StateMark: React.FC<{ state: TaskState; className?: string }> = ({ state, className = '' }) => {
  const tone = state === 'running' ? 'text-[var(--accent-text)]' : state === 'blocked' ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]';
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      data-state={state}
      className={`shrink-0 ${tone} ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {state === 'running' && <circle cx="8" cy="8" r="5" fill="currentColor" stroke="none" className="v2-ball-now" />}
      {state === 'paused' && (
        <>
          <line x1="5.5" y1="3.5" x2="5.5" y2="12.5" />
          <line x1="10.5" y1="3.5" x2="10.5" y2="12.5" />
        </>
      )}
      {state === 'blocked' && (
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
        </>
      )}
      {state === 'upnext' && <circle cx="8" cy="8" r="5" />}
      {state === 'done' && <path d="M3.5 8.5l3 3 6-7" />}
    </svg>
  );
};

const PILL_WORD: Record<TaskState, string> = { running: 'running', paused: 'paused', blocked: 'blocked', upnext: 'planned', done: 'done' };
const PILL_TONE: Record<TaskState, string> = {
  running: 'text-[var(--accent-text)]',
  paused: 'text-[var(--warning)]',
  blocked: 'text-[var(--danger)]',
  upnext: 'text-[var(--text-muted)]',
  done: 'text-[var(--text-muted)]',
};

/** A task's state as a pill: the mark plus the word, so colour is never the only signal. */
export const StatePill: React.FC<{ state: TaskState }> = ({ state }) => (
  <span
    data-state={state}
    className={`inline-flex items-center gap-1 shrink-0 px-2 leading-5 rounded-full border border-[var(--border-control)] text-[length:var(--fs-small)] font-semibold ${PILL_TONE[state]}`}
  >
    <StateMark state={state} className="w-3 h-3 !text-current" />
    {PILL_WORD[state]}
  </span>
);

/** The state a task row shows a mark for. */
export const rowState = (stage: string, running: boolean): TaskState =>
  running ? 'running' : stage === 'done' ? 'done' : stage === 'blocked' ? 'blocked' : stage === 'planned' ? 'upnext' : 'paused';
