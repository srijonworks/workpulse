import React, { useState, useEffect, useRef, useMemo } from 'react';
import { WorkLog, Project } from '../types';
import { Search, X, ExternalLink, Image as ImageIcon, CornerDownLeft } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import { IconButton } from './ui/IconButton';

interface SearchPaletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  logs: WorkLog[];
  projects: Project[];
  onSelectLog: (log: WorkLog) => void;
  onOpenImage: (base64: string) => void;
}

export const SearchPaletteModal: React.FC<SearchPaletteModalProps> = ({
  isOpen,
  onClose,
  logs,
  projects,
  onSelectLog,
  onOpenImage,
}) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) setQuery('');
  }, [isOpen]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return logs.slice(0, 8); // recent 8 when nothing is typed
    return logs.filter(
      (log) =>
        log.description.toLowerCase().includes(q) ||
        log.projectName.toLowerCase().includes(q) ||
        log.tags.some((t) => t.toLowerCase().includes(q)) ||
        (log.linkUrl && log.linkUrl.toLowerCase().includes(q))
    );
  }, [logs, query]);

  // a new query starts at the top of the list
  useEffect(() => setActive(0), [query]);

  // keep the highlighted row on screen while arrowing through a long list
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!isOpen) return null;

  const choose = (log: WorkLog) => {
    onSelectLog(log);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length) setActive((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Home' && results.length) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && results.length) {
      e.preventDefault();
      setActive(results.length - 1);
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      choose(results[active]);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      label="Search work logs"
      align="top"
      closeOnBackdrop
      backdropClassName="p-4 pt-16 sm:pt-24"
      className="bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-[var(--radius-card)] max-w-xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[75vh]"
    >
      <>
        {/* Search Input Bar */}
        <div className="flex items-center gap-3 p-3.5 border-b border-[var(--border-app)] bg-[var(--bg-subtle)]/50">
          <Search className="w-4 h-4 text-[var(--text-muted)] shrink-0" aria-hidden="true" />
          <input
            data-autofocus
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="search-results"
            aria-activedescendant={results[active] ? `search-option-${results[active].id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search work logs, projects, tags and links"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search logs, projects, tags, links"
            className="v2-input h-11 min-w-0 flex-1 px-3 text-[length:var(--fs-body)] text-[var(--text-main)] placeholder:text-[var(--text-muted)]"
          />
          <IconButton label="Close search" onClick={onClose}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* Results List */}
        <div
          id="search-results"
          ref={listRef}
          role="listbox"
          aria-label="Matching work logs"
          className="overflow-y-auto divide-y divide-[var(--border-app)] flex-1"
        >
          {results.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--text-muted)]">
              No work logs match "{query}".
            </div>
          ) : (
            results.map((log, index) => {
              const project = projects.find((p) => p.id === log.projectId);
              const isActive = index === active;

              return (
                <div
                  key={log.id}
                  id={`search-option-${log.id}`}
                  data-index={index}
                  role="option"
                  aria-selected={isActive}
                  onMouseMove={() => !isActive && setActive(index)}
                  onClick={() => choose(log)}
                  className={`p-3.5 transition-colors cursor-pointer group ${
                    isActive ? 'bg-[var(--bg-subtle-hover)]' : ''
                  }`}
                >
                  <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
                    <span className="flex items-center gap-1.5 font-medium text-[var(--text-main)]">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: project?.color || '#6366f1' }}
                        aria-hidden="true"
                      />
                      <span>{log.projectName}</span>
                    </span>
                    <span className="flex items-center gap-2 font-mono tabular-nums">
                      {log.date} · {log.time}
                      {isActive && <CornerDownLeft className="w-3.5 h-3.5 text-[var(--accent-text)]" aria-hidden="true" />}
                    </span>
                  </div>

                  <p className="text-xs text-[var(--text-main)] line-clamp-2 leading-relaxed">
                    {log.description}
                  </p>

                  <div className="flex items-center gap-2 mt-1.5 text-xs text-[var(--text-muted)]">
                    {log.tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                    {log.linkUrl && (
                      <span className="flex items-center gap-0.5 text-[var(--accent-text)]">
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        <span className="truncate max-w-[120px]">{log.linkUrl}</span>
                      </span>
                    )}
                    {log.imageBase64 && (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenImage(log.imageBase64!);
                        }}
                        className="flex items-center gap-0.5 hover:text-[var(--accent-text)]"
                        aria-label="Open attached screenshot"
                      >
                        <ImageIcon className="w-3 h-3" aria-hidden="true" />
                        <span>Proof</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-2.5 border-t border-[var(--border-app)] bg-[var(--bg-subtle)] text-xs text-[var(--text-muted)] flex items-center justify-between">
          <span aria-live="polite">
            {results.length} result{results.length === 1 ? '' : 's'}
          </span>
          <span className="font-mono">↑↓ move · Enter open · Esc close</span>
        </div>
      </>
    </ModalShell>
  );
};
