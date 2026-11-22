import { describe, it, expect } from 'vitest';
import { splitProjectTag, typoDistance } from './projects';
import type { Project } from '../types';

const p = (id: string, name: string, isArchived = false): Project => ({ id, name, color: '#000000', isArchived });
const projects = [p('a', 'BGB Portal'), p('b', 'HR Dashboard'), p('c', 'Old thing', true), p('d', 'Hr tools')];

describe('splitProjectTag', () => {
  it('returns the text untouched when there is no trailing #word', () => {
    expect(splitProjectTag('Fix the date filter', projects)).toEqual({ text: 'Fix the date filter' });
    expect(splitProjectTag('Review PR #212 today', projects)).toEqual({ text: 'Review PR #212 today' });
  });

  it('picks the first active project whose name starts with the tag, ignoring case and spaces', () => {
    expect(splitProjectTag('Fix the date filter #bgb', projects)).toEqual({ text: 'Fix the date filter', tag: 'bgb', project: projects[0] });
    expect(splitProjectTag('Fix it #BGBPor', projects).project?.id).toBe('a');
    expect(splitProjectTag('Leave table #hr', projects).project?.id).toBe('b');
  });

  it('prefers an exact name over an earlier prefix match', () => {
    const list = [p('x', 'App Admin'), p('y', 'App')];
    expect(splitProjectTag('Ship it #App', list).project?.id).toBe('y');
    expect(splitProjectTag('Ship it #app', list).project?.id).toBe('y');
    expect(splitProjectTag('Ship it #AppA', list).project?.id).toBe('x');
    expect(splitProjectTag('Ship it #Ap', list).project?.id).toBe('x');
    // an archived exact match does not win
    expect(splitProjectTag('Ship it #App', [p('z', 'App', true), p('x', 'App Admin')]).project?.id).toBe('x');
  });

  it('skips archived projects', () => {
    expect(splitProjectTag('Clean up #old', projects)).toEqual({ text: 'Clean up #old', tag: 'old' });
  });

  it('keeps the text whole when nothing matches (it may be "PR #212"), and reports the tag', () => {
    expect(splitProjectTag('Write docs #nope', projects)).toEqual({ text: 'Write docs #nope', tag: 'nope' });
    expect(splitProjectTag('Review PR #212', projects)).toEqual({ text: 'Review PR #212', tag: '212' });
  });

  it('ignores trailing spaces and a tag on its own', () => {
    expect(splitProjectTag('Write docs #hr  ', projects).project?.id).toBe('b');
    expect(splitProjectTag('#hr', projects)).toEqual({ text: '', tag: 'hr', project: projects[1] });
  });
});

describe('splitProjectTag: typos and a tag typed first', () => {
  const list = [p('h', 'hims'), p('i', 'idim'), p('g', 'General')];
  it('picks the one project a single typo away', () => {
    expect(splitProjectTag('Stock page stale #hmis', list)).toEqual({ text: 'Stock page stale', tag: 'hmis', project: list[0] });
    expect(splitProjectTag('Fix it #idmi', list).project?.id).toBe('i');
  });
  it('a tag typed first, then the task, picks the project and leaves the task text', () => {
    expect(splitProjectTag('#hmis CHUADANGA Stock stay stale', list)).toEqual({ text: 'CHUADANGA Stock stay stale', tag: 'hmis', project: list[0] });
    expect(splitProjectTag('#hims Fix the page', list).project?.id).toBe('h');
  });
  it('leaves short words, numbers and unknown words alone', () => {
    expect(splitProjectTag('Fix it #hi', list).project?.id).toBe('h'); // a prefix, not a typo
    expect(splitProjectTag('Fix it #hm', list).project).toBeUndefined(); // too short to be a typo
    expect(splitProjectTag('Fix it #xyz', list).project).toBeUndefined();
    expect(splitProjectTag('#212 is the PR to review', list)).toEqual({ text: '#212 is the PR to review' });
    expect(splitProjectTag('#nope do this', list)).toEqual({ text: '#nope do this' });
  });
  it('typoDistance counts a swap of neighbours as one edit', () => {
    expect(typoDistance('hmis', 'hims')).toBe(1);
    expect(typoDistance('hims', 'hims')).toBe(0);
    expect(typoDistance('hid', 'hmi')).toBe(2);
  });
});
