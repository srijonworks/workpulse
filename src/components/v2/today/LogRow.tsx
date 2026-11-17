import React, { useEffect, useState } from 'react';
import type { Project, WorkLog } from '../../../types';
import { RowMenu, RowMenuItem } from '../RowMenu';
import { SampleBadge } from '../../ui/SampleBadge';
import { isSampleLog } from '../../../data/sampleData';

export interface LogRowProps {
  log: WorkLog;
  /** The log's project (ribbon colour). Absent: the project was deleted; the log keeps its name. */
  project?: Project;
  /** Each menu item shows only when its handler is given. Copy is always there. */
  onEdit?(log: WorkLog): void;
  onDuplicate?(log: WorkLog): void;
  onDelete?(id: string): void;
  /** Shows the date before the time (History, End my day across days). */
  showDate?: boolean;
  /** Shows a selection checkbox when given. */
  selected?: boolean;
  onToggleSelect?(id: string): void;
  /** Added after Edit, Duplicate and Copy, before Delete. */
  extraMenuItems?: RowMenuItem[];
  /** Opens the log's screenshot (a v1 log may have one). "View screenshot" shows only when given. */
  onOpenImage?(base64: string): void;
}

/** "0:34" from minutes (workday.ts formatHm takes seconds). */
export const formatMinutes = (minutes: number): string => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

const STATUS_LABEL: Record<WorkLog['status'], string> = { completed: 'Done', in_progress: 'In progress', blocked: 'Blocked' };

/** One log: time · ribbon · text · duration, and a ⋯ menu (Edit, Duplicate, Copy, Delete). */
export const LogRow: React.FC<LogRowProps> = ({ log, project, onEdit, onDuplicate, onDelete, showDate, selected, onToggleSelect, extraMenuItems = [], onOpenImage }) => {
  const [copied, setCopied] = useState<'' | 'ok' | 'failed'>('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(''), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = () => {
    if (!navigator.clipboard) {
      setCopied('failed');
      return;
    }
    navigator.clipboard.writeText(log.description).then(
      () => setCopied('ok'),
      () => setCopied('failed'),
    );
  };

  const items: RowMenuItem[] = [];
  if (onEdit) items.push({ label: 'Edit', onSelect: () => onEdit(log) });
  if (onDuplicate) items.push({ label: 'Duplicate', onSelect: () => onDuplicate(log) });
  items.push({ label: 'Copy text', onSelect: copy });
  // A log saved with a screenshot (the v1 form) still shows it; the v2 form cannot add one.
  const image = log.imageBase64;
  if (image && onOpenImage) items.push({ label: 'View screenshot', onSelect: () => onOpenImage(image) });
  items.push(...extraMenuItems);
  if (onDelete) items.push({ label: 'Delete', danger: true, onSelect: () => onDelete(log.id) });

  const minutes = log.durationMinutes ?? 0;
  const short = log.description.length > 50 ? `${log.description.slice(0, 50)}…` : log.description;

  return (
    <li className="v2-row v2-inset" data-log-id={log.id}>
      <div className="flex items-center gap-3">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect(log.id)}
            aria-label={`Select: ${short}`}
            className="w-4 h-4 shrink-0 accent-[var(--accent-text)]"
          />
        )}
        <span className="num shrink-0 w-12 text-[length:var(--fs-small)] text-[var(--text-muted)]">
          {showDate && <span className="block">{log.date.slice(5)}</span>}
          {log.time}
        </span>
        <span className="v2-ribbon self-stretch min-h-5" style={{ backgroundColor: project?.color ?? 'var(--border-control)' }} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="text-[length:var(--fs-body)] text-[var(--text-main)] break-words">{log.description}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-small)] text-[var(--text-muted)]">
            <span>{project?.name ?? log.projectName}</span>
            {log.status !== 'completed' && (
              <span className={log.status === 'blocked' ? 'text-danger font-semibold' : 'font-semibold'}>{STATUS_LABEL[log.status]}</span>
            )}
            {log.underlyingTasks && log.underlyingTasks.length > 0 && (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="underline underline-offset-2 decoration-dotted hover:text-[var(--text-main)] cursor-pointer"
              >
                {open ? '▾' : '▸'} {log.underlyingTasks.length} {log.underlyingTasks.length === 1 ? 'sub-task' : 'sub-tasks'}
              </button>
            )}
            <SampleBadge show={isSampleLog(log)} />
            {log.origin === 'auto' && <span className="font-semibold" title="Added automatically from your day's activity">Auto</span>}
            {copied && (
              <span role="status" className={copied === 'ok' ? 'text-[var(--accent-text)]' : 'text-danger'}>
                {copied === 'ok' ? 'Copied' : 'Could not copy'}
              </span>
            )}
          </p>
          {open && log.underlyingTasks && (
            <ul className="mt-1.5 list-disc pl-5 space-y-0.5 text-[length:var(--fs-small)] text-[var(--text-main)]">
              {log.underlyingTasks.map((t, i) => (
                <li key={i} className="break-words">
                  {typeof t === 'string' ? t : (t as { text?: string; title?: string }).text ?? (t as { title?: string }).title ?? ''}
                </li>
              ))}
            </ul>
          )}
        </div>
        <span className="num shrink-0 text-[length:var(--fs-body)] font-semibold text-[var(--text-main)]">
          {minutes > 0 ? (
            formatMinutes(minutes)
          ) : (
            <>
              <span aria-hidden="true" className="text-[var(--text-muted)]">
                --:--
              </span>
              <span className="sr-only">No duration</span>
            </>
          )}
        </span>
        <RowMenu label={`Actions for log: ${short}`} items={items} />
      </div>
    </li>
  );
};
