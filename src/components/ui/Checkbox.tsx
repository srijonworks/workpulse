import React from 'react';

// The app's tick box with its label: the box follows the theme colour, and box and text sit on one centred line.
// Use it instead of a bare <input type="checkbox"> next to loose text.

interface Props {
  checked: boolean;
  onChange(checked: boolean): void;
  children: React.ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export const Checkbox: React.FC<Props> = ({ checked, onChange, children, disabled, id, className = '' }) => (
  <label
    className={`inline-flex min-h-8 pointer-coarse:min-h-11 w-fit items-center gap-2.5 text-[length:var(--fs-small)] leading-snug text-[var(--text-main)] ${
      disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
    } ${className}`}
  >
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="m-0 h-[1.125rem] w-[1.125rem] shrink-0 cursor-[inherit]"
    />
    <span>{children}</span>
  </label>
);
