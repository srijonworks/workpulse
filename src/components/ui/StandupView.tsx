import React from 'react';
import type { Project } from '../../types';
import { parseInline } from '../../utils/richText';
import { isNothing, parseStandup, type SectionKind, type StandupPoint } from '../../utils/standupDoc';
import { inline } from './RichText';

// A standup drawn the same way as in the emails (src/utils/appsScript/email.ts, standupHtml_): each section's heading with a
// dot for its kind, then each project on its own line in its colour, its points with "•", and sub-points indented with "-".
// Read-only; the stored text is unchanged and still copies with its marks.

const DOT: Record<SectionKind, string> = {
  done: 'var(--success-solid)',
  doing: 'var(--warning-solid)',
  blocked: 'var(--danger-solid)',
  other: 'var(--accent-text)',
};

const Point: React.FC<{ point: StandupPoint }> = ({ point }) => (
  <li className="flex gap-2">
    <span aria-hidden="true" className="shrink-0 text-[var(--text-muted)]">•</span>
    <div className="min-w-0">
      <span className={isNothing(point.text) ? 'text-[var(--text-muted)]' : ''}>{inline(parseInline(point.text))}</span>
      {point.subs.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 pl-6 text-[length:var(--fs-small)] text-[var(--text-muted)]">
          {point.subs.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden="true" className="shrink-0">-</span>
              <span className="min-w-0">{inline(parseInline(s))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  </li>
);

export const StandupView: React.FC<{ text: string; projects: Project[]; className?: string }> = ({ text, projects, className }) => {
  const colorOf = (label: string) => projects.find((p) => p.name.toLowerCase() === label.toLowerCase())?.color;
  return (
    <div className={`flex flex-col leading-relaxed ${className ?? ''}`}>
      {parseStandup(text).map((sec, i) => (
        <section key={i} aria-label={sec.title || undefined} className={i > 0 ? 'mt-4 border-t border-[var(--border-app)] pt-4' : ''}>
          {sec.title && (
            <h4 className="flex items-center gap-2.5 text-[length:calc(var(--fs-body)+1px)] font-bold text-[var(--text-main)]">
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: DOT[sec.kind] }} />
              {inline(parseInline(sec.title))}
            </h4>
          )}
          <div className="flex flex-col gap-3 [&:not(:first-child)]:mt-3">
            {sec.items.map((it, j) => {
              if (it.kind === 'project') {
                const color = colorOf(it.label);
                return (
                  <section key={j} aria-label={it.label}>
                    <div className="flex items-center gap-2 text-[length:var(--fs-small)] font-bold text-[var(--text-main)]">
                      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: color ?? 'var(--text-muted)' }} />
                      {it.label}
                    </div>
                    <ul className="mt-1.5 flex flex-col gap-1.5">
                      {it.points.map((p, k) => (
                        <Point key={k} point={p} />
                      ))}
                    </ul>
                  </section>
                );
              }
              if (it.kind === 'point') {
                return (
                  <ul key={j}>
                    <Point point={it.point} />
                  </ul>
                );
              }
              return <p key={j}>{inline(parseInline(it.text))}</p>;
            })}
          </div>
        </section>
      ))}
    </div>
  );
};
