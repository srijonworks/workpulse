import { describe, it, expect } from 'vitest';
import { normalizeTheme, THEMES } from './theme';

describe('normalizeTheme', () => {
  it('keeps the v2 themes', () => {
    expect(normalizeTheme('chase')).toBe('chase');
    expect(normalizeTheme('timecard')).toBe('timecard');
    expect(normalizeTheme('console')).toBe('console');
    expect(normalizeTheme('nightdesk')).toBe('nightdesk');
  });

  it('maps the four old themes', () => {
    expect(normalizeTheme('modern')).toBe('chase');
    expect(normalizeTheme('compact')).toBe('chase');
    expect(normalizeTheme('minimalist')).toBe('timecard');
    expect(normalizeTheme('matrix')).toBe('console');
  });

  it('falls back to chase for anything else', () => {
    expect(normalizeTheme(undefined)).toBe('chase');
    expect(normalizeTheme('nonsense')).toBe('chase');
    expect(normalizeTheme(null)).toBe('chase');
    expect(normalizeTheme(42)).toBe('chase');
  });
});

describe('THEMES', () => {
  it('lists the themes in order with their names', () => {
    expect(THEMES.map(t => t.id)).toEqual(['chase', 'timecard', 'console', 'nightdesk']);
    expect(THEMES.map(t => t.name)).toEqual(['The Chase', 'Time Card', 'Graphite Console', 'Night Desk']);
    expect(THEMES.find(t => t.id === 'nightdesk')?.dark).toBe(true);
    expect(THEMES.find(t => t.id === 'console')?.dark).toBe(true);
    expect(THEMES.filter(t => t.dark)).toHaveLength(2);
  });
});
