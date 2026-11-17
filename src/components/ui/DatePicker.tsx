import React, { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover } from './Popover';
import { localDateStr } from '../../utils/dates';
import { MONTHS, WEEKDAYS_SHORT, addDaysIso, addMonths, formatDateLong, formatDateShort, monthGrid, parseIso, withinLimits } from '../../utils/calendar';

// The app's date picker, instead of the browser's own (which cannot follow the theme and differs per browser). The value is a
// local `YYYY-MM-DD` string, like every date in the app. Keyboard in the grid: arrows move a day or a week, PageUp/PageDown a
// month, Enter picks, Escape closes (and does not close a dialog around it). A typed date is accepted too.

interface Props {
  /** `YYYY-MM-DD`, or '' for no date. */
  value: string;
  onChange(iso: string): void;
  id?: string;
  ariaLabel?: string;
  min?: string;
  max?: string;
  /** Shows a Clear button and allows an empty value. */
  clearable?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

const NAV =
  'inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-btn)] text-[var(--text-main)] hover:bg-[var(--bg-subtle)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
const LINK = 'min-h-8 px-2 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] underline underline-offset-4 cursor-pointer';

export const DatePicker: React.FC<Props> = ({ value, onChange, id, ariaLabel, min, max, clearable, placeholder = 'Pick a date', disabled, className = '', 'data-testid': testId }) => {
  const uid = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const today = localDateStr();
  const valid = parseIso(value) ? value : '';
  // The day the keyboard is on, and the month shown.
  const [focusIso, setFocusIso] = useState(valid || today);
  const [typedText, setTypedText] = useState('');
  const [typedError, setTypedError] = useState('');
  const shown = parseIso(focusIso) ?? parseIso(today)!;
  const gridRef = useRef<HTMLDivElement>(null);

  const openPicker = () => {
    if (disabled) return;
    const start = valid || (withinLimits(today, min, max) ? today : (min ?? max ?? today));
    setFocusIso(start);
    setTypedText(valid);
    setTypedError('');
    setOpen(true);
  };
  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) btn.current?.focus();
  };
  const pick = (iso: string) => {
    if (!withinLimits(iso, min, max)) return;
    onChange(iso);
    close();
  };

  // Focus the day the keyboard is on whenever it moves while the picker is open.
  useEffect(() => {
    if (!open) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focusIso}"]`)?.focus({ preventScroll: true });
  }, [open, focusIso]);

  const goto = (iso: string) => setFocusIso(iso);
  const onGridKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    let next: string | null = null;
    if (k === 'ArrowLeft') next = addDaysIso(focusIso, -1);
    else if (k === 'ArrowRight') next = addDaysIso(focusIso, 1);
    else if (k === 'ArrowUp') next = addDaysIso(focusIso, -7);
    else if (k === 'ArrowDown') next = addDaysIso(focusIso, 7);
    else if (k === 'PageUp' || k === 'PageDown') {
      const m = addMonths(shown.y, shown.m0, k === 'PageUp' ? -1 : 1);
      next = `${m.y}-${String(m.m0 + 1).padStart(2, '0')}-${String(Math.min(shown.d, new Date(m.y, m.m0 + 1, 0).getDate())).padStart(2, '0')}`;
    } else if (k === 'Home') next = addDaysIso(focusIso, -new Date(shown.y, shown.m0, shown.d).getDay());
    else if (k === 'End') next = addDaysIso(focusIso, 6 - new Date(shown.y, shown.m0, shown.d).getDay());
    if (next) {
      e.preventDefault();
      goto(next);
    }
  };

  const applyTyped = () => {
    const p = parseIso(typedText.trim());
    if (!p) return setTypedError('Type the date as year-month-day, like 2026-11-17.');
    const iso = typedText.trim();
    if (!withinLimits(iso, min, max)) return setTypedError(max && iso > max ? 'That date is too late.' : 'That date is too early.');
    pick(iso);
  };

  const cells = monthGrid(shown.y, shown.m0);
  const prev = addMonths(shown.y, shown.m0, -1);
  const next = addMonths(shown.y, shown.m0, 1);
  const monthOf = (m: { y: number; m0: number }) => `${m.y}-${String(m.m0 + 1).padStart(2, '0')}-01`;

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={testId}
        data-value={valid}
        disabled={disabled}
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(e) => {
          if (!open && e.key === 'ArrowDown') {
            e.preventDefault();
            openPicker();
          } else if (open && e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        className={`v2-input ${/(^|\s)h-/.test(className) ? '' : 'h-10'} w-full px-3 flex items-center justify-between gap-2 text-left text-[length:var(--fs-body)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed aria-expanded:border-[var(--border-focus)] ${className}`}
      >
        <span className={`num min-w-0 truncate ${valid ? '' : 'text-[var(--text-muted)]'}`}>{valid ? formatDateShort(valid) : placeholder}</span>
        <CalendarDays className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      </button>
      {open && (
        <Popover anchor={btn} onClose={() => close(false)} width={288} maxHeight={460} className="p-3" onPlaced={() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focusIso}"]`)?.focus({ preventScroll: true })}>
          <div
            role="dialog"
            aria-label="Choose a date"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault(); // so the dialog around this control stays open
                close();
              }
            }}
          >
            <div className="flex items-center justify-between pb-2">
              <button type="button" className={NAV} aria-label="Previous month" onClick={() => goto(monthOf(prev))}>
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <div className="text-[length:var(--fs-body)] font-bold" aria-live="polite">
                {MONTHS[shown.m0]} {shown.y}
              </div>
              <button type="button" className={NAV} aria-label="Next month" onClick={() => goto(monthOf(next))}>
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div ref={gridRef} role="grid" aria-label={`${MONTHS[shown.m0]} ${shown.y}`} onKeyDown={onGridKey}>
              <div role="row" className="grid grid-cols-7 pb-1">
                {WEEKDAYS_SHORT.map((d) => (
                  <div key={d} role="columnheader" className="h-8 text-center text-[length:var(--fs-small)] leading-8 text-[var(--text-muted)]">
                    {d}
                  </div>
                ))}
              </div>
              {Array.from({ length: 6 }, (_, w) => (
                <div key={w} role="row" className="grid grid-cols-7">
                  {cells.slice(w * 7, w * 7 + 7).map((c) => {
                    const selected = c.iso === valid;
                    const isToday = c.iso === today;
                    const allowed = withinLimits(c.iso, min, max);
                    return (
                      <button
                        key={c.iso}
                        type="button"
                        role="gridcell"
                        data-iso={c.iso}
                        aria-selected={selected}
                        aria-label={formatDateLong(c.iso)}
                        aria-current={isToday ? 'date' : undefined}
                        tabIndex={c.iso === focusIso ? 0 : -1}
                        disabled={!allowed}
                        onClick={() => pick(c.iso)}
                        className={`num m-0.5 h-9 rounded-[var(--radius-btn)] text-[length:var(--fs-body)] cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 ${
                          selected
                            ? 'bg-[var(--accent)] font-bold text-[var(--on-accent)]'
                            : `${c.inMonth ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)] opacity-60'} hover:bg-[var(--bg-subtle)]`
                        } ${isToday && !selected ? 'border border-[var(--accent-text)]' : ''}`}
                      >
                        {c.day}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mt-2 border-t border-[var(--border-app)] pt-2">
              <label htmlFor={`${uid}-typed`} className="sr-only">
                Type a date
              </label>
              <input
                id={`${uid}-typed`}
                value={typedText}
                onChange={(e) => {
                  setTypedText(e.target.value);
                  setTypedError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyTyped();
                  }
                }}
                placeholder="YYYY-MM-DD"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={typedError ? true : undefined}
                className="v2-input num h-9 w-full px-3 text-[length:var(--fs-small)]"
              />
              {typedError && (
                <p role="alert" className="mt-1 text-[length:var(--fs-small)] text-[var(--danger)]">
                  {typedError}
                </p>
              )}
            </div>
            <div className="mt-1 flex items-center justify-between">
              <button type="button" className={LINK} onClick={() => pick(today)} disabled={!withinLimits(today, min, max)}>
                Today
              </button>
              {clearable && (
                <button
                  type="button"
                  className={LINK}
                  onClick={() => {
                    onChange('');
                    close();
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
};
