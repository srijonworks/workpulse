import React, { useId } from 'react';
import type { BacklogTask } from '../../../types';

export const plural = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;

const TEXT_BTN =
  'shrink-0 min-h-8 pointer-coarse:min-h-11 px-1 normal-case tracking-normal text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] underline underline-offset-4 cursor-pointer';

/** "Move all to today" for one date group. The date is added for screen readers, so each button has its own name. */
const MoveAll: React.FC<{ heading: string; onClick(): void }> = ({ heading, onClick }) => (
  <button type="button" onClick={onClick} className={TEXT_BTN}>
    Move all to today
    <span className="sr-only"> from {heading}</span>
  </button>
);

interface DayBlockProps {
  /** The group's name: Overdue, Today · Sun 22 Nov, This week, Later. */
  heading: string;
  tasks: BacklogTask[];
  /** Adds "Move all to today" (the Overdue group). */
  onMoveAll?(ids: string[]): void;
  children: React.ReactNode;
}

/** A date group inside a panel (the Plan screen): the same day heading style as elsewhere, then the rows. */
export const DayBlock: React.FC<DayBlockProps> = ({ heading, tasks, onMoveAll, children }) => {
  const id = useId();
  return (
    <div role="group" aria-labelledby={`${id}-h`}>
      {/* !flex-nowrap: "Move all to today" never drops to its own line; the count gives way first. */}
      <div className="v2-head v2-head-split v2-inset pt-5 !mb-0 !flex-nowrap">
        <h3 id={`${id}-h`} className="v2-head-group">
          <span>{heading}</span>
          <span className="v2-head-meta num">{plural(tasks.length)}</span>
        </h3>
        {onMoveAll && <MoveAll heading={heading} onClick={() => onMoveAll(tasks.map((t) => t.id))} />}
      </div>
      {children}
    </div>
  );
};
