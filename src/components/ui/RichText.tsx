import React from 'react';
import { parseBlocks, type Inline } from '../../utils/richText';

// Shows standups and AI summaries with their *bold*, _italic_, `code`, links, bullets and headings drawn properly. Elements only,
// never HTML strings. Use for read-only text; editable text stays in a textarea.

const inline = (parts: Inline[]): React.ReactNode[] =>
  parts.map((p, i) => {
    switch (p.kind) {
      case 'bold':
        return <strong key={i}>{p.text}</strong>;
      case 'italic':
        return <em key={i}>{p.text}</em>;
      case 'code':
        return (
          <code key={i} className="rounded bg-[var(--surface-sunken,rgba(0,0,0,0.06))] px-1 font-mono text-[0.92em]">
            {p.text}
          </code>
        );
      case 'link':
        return (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {p.text}
          </a>
        );
      default:
        return <React.Fragment key={i}>{p.text}</React.Fragment>;
    }
  });

export const RichText: React.FC<{ text: string; className?: string }> = ({ text, className }) => (
  <div className={`flex flex-col gap-1.5 leading-relaxed ${className ?? ''}`}>
    {parseBlocks(text).map((b, i) => {
      if (b.kind === 'blank') return <div key={i} aria-hidden="true" className="h-1" />;
      if (b.kind === 'heading') {
        return (
          <div key={i} className="mt-1 border-b border-[var(--border-app)] pb-1 font-bold text-[var(--text-main)] first:mt-0">
            {inline(b.inline)}
          </div>
        );
      }
      if (b.kind === 'bullet') {
        return (
          <div key={i} className="flex gap-2">
            <span aria-hidden="true" className="shrink-0">{b.marker}</span>
            <span className="min-w-0">{inline(b.inline)}</span>
          </div>
        );
      }
      return <div key={i}>{inline(b.inline)}</div>;
    })}
  </div>
);
