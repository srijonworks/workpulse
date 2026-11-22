import { describe, it, expect } from 'vitest';
import type { Project } from '../types';
import { completionState, applyCompletion, nextSwatchColor, resolveProject, tagOf } from './projectCompletion';
import { SWATCHES } from '../components/v2/ProjectSwatches';

const proj = (id: string, name: string, extra: Partial<Project> = {}): Project => ({ id, name, color: '#000000', isArchived: false, ...extra });
const projects = [proj('p1', 'General'), proj('p2', 'HMIS Portal'), proj('p3', 'Payroll'), proj('p4', 'Hidden', { isArchived: true })];

describe('completionState', () => {
  it('stays closed when the last word is not a #tag', () => {
    expect(completionState('', projects).open).toBe(false);
    expect(completionState('write report', projects).open).toBe(false);
    expect(completionState('fix #h now', projects).open).toBe(false);
    expect(completionState('fix a#h', projects).open).toBe(false);
  });

  it('leaves a purely numeric word alone', () => {
    expect(completionState('Review PR #212', projects).open).toBe(false);
  });

  it('lists every active project for a bare #', () => {
    const s = completionState('Task #', projects);
    expect(s.open).toBe(true);
    expect(s.matches.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(s.canCreate).toBe(false);
  });

  it('matches names by prefix, ignoring case and spaces, and skips archived projects', () => {
    expect(completionState('Task #h', projects).matches.map((p) => p.id)).toEqual(['p2']);
    expect(completionState('Task #HMISpo', projects).matches.map((p) => p.id)).toEqual(['p2']);
    expect(completionState('Task #hid', projects)).toMatchObject({ open: true, canCreate: true, matches: [] });
  });

  it('offers to create when nothing matches', () => {
    const s = completionState('Task #xyz', projects);
    expect(s).toMatchObject({ open: true, canCreate: true, query: 'xyz' });
  });

  it('reports where the word sits', () => {
    expect(completionState('Task #h', projects)).toMatchObject({ wordStart: 5, wordEnd: 7 });
    expect(completionState('#h', projects)).toMatchObject({ wordStart: 0, wordEnd: 2 });
  });

  it('stays closed once a space follows the word', () => {
    expect(completionState('Task #h ', projects).open).toBe(false);
  });
});

describe('applyCompletion', () => {
  it('removes the #word and the space before it', () => {
    expect(applyCompletion('Fix login #h', projects[1], 'remove')).toBe('Fix login');
    expect(applyCompletion('#h', projects[1], 'remove')).toBe('');
  });

  it('replaces the word with the full tag, without spaces', () => {
    expect(applyCompletion('Fix login #h', projects[1], 'replace')).toBe('Fix login #HMISPortal');
    expect(tagOf(projects[1])).toBe('#HMISPortal');
  });

  it('only touches the last line of a multi-line text', () => {
    expect(applyCompletion('One #pay\nTwo #h', projects[1], 'replace')).toBe('One #pay\nTwo #HMISPortal');
  });

  it('returns the text unchanged when there is no tag', () => {
    expect(applyCompletion('plain', projects[0], 'remove')).toBe('plain');
  });
});

describe('nextSwatchColor', () => {
  it('takes the first swatch no project uses', () => {
    expect(nextSwatchColor([])).toBe(SWATCHES[0].hex);
    expect(nextSwatchColor([proj('a', 'A', { color: SWATCHES[0].hex.toUpperCase() })])).toBe(SWATCHES[1].hex);
  });

  it('treats a project with no colour as using none', () => {
    const noColor = { id: 'n', name: 'N', isArchived: false } as unknown as Project;
    expect(nextSwatchColor([noColor])).toBe(SWATCHES[0].hex);
  });

  it('cycles once every swatch is taken', () => {
    const all = SWATCHES.map((s, i) => proj(`s${i}`, `S${i}`, { color: s.hex }));
    expect(nextSwatchColor(all)).toBe(SWATCHES[0].hex);
  });
});

describe('resolveProject', () => {
  it('prefers the chosen project, then the last used, then the first active', () => {
    expect(resolveProject(projects, 'p3', 'p2')?.id).toBe('p3');
    expect(resolveProject(projects, undefined, 'p2')?.id).toBe('p2');
    expect(resolveProject(projects, undefined, undefined)?.id).toBe('p1');
  });

  it('ignores archived or missing ids', () => {
    expect(resolveProject(projects, 'p4', 'gone')?.id).toBe('p1');
  });
});

describe('completionState: typos', () => {
  const list = [proj('h', 'hims'), proj('i', 'idim')];
  it('offers the project one typo away, and still offers to create the word', () => {
    expect(completionState('#hmis', list)).toMatchObject({ open: true, canCreate: true });
    expect(completionState('#hmis', list).matches.map((p) => p.id)).toEqual(['h']);
  });
  it('offers no typo matches for a short word or when a name starts with it', () => {
    expect(completionState('#hi', list).matches.map((p) => p.id)).toEqual(['h']);
    expect(completionState('#hi', list).canCreate).toBe(false);
    expect(completionState('#hm', list)).toMatchObject({ matches: [], canCreate: true });
    expect(completionState('#xq', list)).toMatchObject({ matches: [], canCreate: true });
  });
});
