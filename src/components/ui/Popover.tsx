import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The floating panel under a control (the dropdown list, the calendar). It is drawn on <body> and fixed to the screen, so a
// dialog's edge never clips it, it opens upward when there is no room below, and it closes on a press outside, a scroll
// of the page behind it, or a resize. Escape and keys are the owner's job (they know what Escape should do).

interface Props {
  /** The control the panel hangs from. */
  anchor: React.RefObject<HTMLElement | null>;
  onClose(): void;
  /** At least as wide as the control; or a fixed width. */
  width?: 'anchor' | number;
  /** The tallest the panel may be before it scrolls. */
  maxHeight?: number;
  id?: string;
  /** Called once the panel is placed and visible (a hidden element cannot take focus before that). */
  onPlaced?(): void;
  children: React.ReactNode;
  className?: string;
}

const GAP = 4;
const MARGIN = 8;

export const Popover: React.FC<Props> = ({ anchor, onClose, width = 'anchor', maxHeight = 280, id, onPlaced, children, className = '' }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxH: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current;
      const p = ref.current;
      if (!a || !p) return;
      const r = a.getBoundingClientRect();
      const w = width === 'anchor' ? Math.max(r.width, 160) : width;
      const left = Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, window.innerWidth - w - MARGIN));
      const wanted = Math.min(p.scrollHeight, maxHeight);
      const below = window.innerHeight - r.bottom - MARGIN - GAP;
      const above = r.top - MARGIN - GAP;
      if (below >= wanted || below >= above) {
        setPos({ left, top: r.bottom + GAP, width: w, maxH: Math.max(120, Math.min(maxHeight, below)) });
      } else {
        setPos({ left, bottom: window.innerHeight - r.top + GAP, width: w, maxH: Math.max(120, Math.min(maxHeight, above)) });
      }
    };
    place();
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return; // the panel's own scroll
      closeRef.current();
    };
    const onPress = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      closeRef.current();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [anchor, width, maxHeight]);

  const placedRef = useRef(onPlaced);
  placedRef.current = onPlaced;
  const placed = pos !== null;
  useEffect(() => {
    if (placed) placedRef.current?.();
  }, [placed]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top,
        bottom: pos?.bottom,
        width: pos?.width,
        maxHeight: pos?.maxH,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className={`z-[70] overflow-auto bg-[var(--bg-surface-elevated)] text-[var(--text-main)] border border-[var(--border-control)] rounded-[var(--radius-card)] ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
};
