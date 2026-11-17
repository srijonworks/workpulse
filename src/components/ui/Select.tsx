import React, { useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover } from './Popover';

// The app's dropdown. It replaces the browser's own <select>, which cannot follow the theme. Keyboard: Down/Up/Home/End move,
// Enter or Space picks, Escape closes (and does not close a dialog around it), typing a letter jumps to a matching option.
// The control keeps the keyboard focus; the highlighted option is announced through aria-activedescendant.

export interface SelectOption {
  value: string;
  label: string;
  /** A muted second line or tail (e.g. "archived"). */
  hint?: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  onChange(value: string): void;
  options: SelectOption[];
  /** id for a <label htmlFor>, or pass `ariaLabel`. */
  id?: string;
  ariaLabel?: string;
  /** Shown when nothing matches `value`. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Lower control (the row inside a dialog list). */
  compact?: boolean;
  /** Only as wide as its content, for a control beside others in a row. */
  inline?: boolean;
  'data-testid'?: string;
}

export const Select: React.FC<Props> = ({ value, onChange, options, id, ariaLabel, placeholder = 'Choose…', disabled, className = '', compact, inline, 'data-testid': testId }) => {
  const uid = useId();
  const listId = `${uid}-list`;
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const [active, setActive] = useState(0);
  const typed = useRef({ text: '', at: 0 });
  const current = options[selectedIndex];

  const enabledIdx = useMemo(() => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0), [options]);
  const openList = () => {
    if (disabled) return;
    setActive(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : (enabledIdx[0] ?? 0));
    setOpen(true);
  };
  const close = () => setOpen(false);
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
    btn.current?.focus();
  };
  const move = (dir: 1 | -1 | 'first' | 'last') => {
    if (enabledIdx.length === 0) return;
    const pos = enabledIdx.indexOf(active);
    const next = dir === 'first' ? 0 : dir === 'last' ? enabledIdx.length - 1 : Math.min(enabledIdx.length - 1, Math.max(0, (pos < 0 ? 0 : pos) + dir));
    setActive(enabledIdx[next]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (k === 'Escape') {
      e.preventDefault(); // so the dialog around this control stays open
      close();
    } else if (k === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (k === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (k === 'Home') {
      e.preventDefault();
      move('first');
    } else if (k === 'End') {
      e.preventDefault();
      move('last');
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      choose(active);
    } else if (k === 'Tab') {
      close();
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + k.toLowerCase(), at: now };
      const hit = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  };

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${uid}-o${active}` : undefined}
        aria-label={ariaLabel}
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        className={`v2-input ${inline ? 'min-w-[9rem]' : 'w-full'} ${/(^|\s)h-/.test(className) ? '' : compact ? 'h-9' : 'h-10'} ${compact ? 'text-[length:var(--fs-small)]' : 'text-[length:var(--fs-body)]'} px-3 flex items-center justify-between gap-2 text-left cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed aria-expanded:border-[var(--border-focus)] ${className}`}
      >
        <span className={`min-w-0 truncate ${current ? '' : 'text-[var(--text-muted)]'}`}>{current ? current.label : placeholder}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <Popover anchor={btn} onClose={close} id={listId} maxHeight={280} className="py-1">
          <ul role="listbox" aria-label={ariaLabel}>
            {options.map((o, i) => {
              const selected = i === selectedIndex;
              return (
                <li
                  key={o.value}
                  id={`${uid}-o${i}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={o.disabled || undefined}
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()} // the control keeps the focus
                  onClick={() => choose(i)}
                  className={`flex min-h-10 cursor-pointer items-center justify-between gap-3 px-3 text-[length:var(--fs-body)] ${
                    i === active ? 'bg-[var(--bg-subtle)]' : ''
                  } ${selected ? 'font-semibold text-[var(--accent-text)]' : ''} ${o.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <span className="min-w-0 truncate">{o.label}</span>
                  {o.hint && <span className="shrink-0 text-[length:var(--fs-small)] font-normal text-[var(--text-muted)]">{o.hint}</span>}
                  {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                </li>
              );
            })}
            {options.length === 0 && <li className="px-3 py-2 text-[length:var(--fs-small)] text-[var(--text-muted)]">Nothing to choose from.</li>}
          </ul>
        </Popover>
      )}
    </>
  );
};
