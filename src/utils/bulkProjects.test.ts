import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { bulkMessage, planBulkProjects } from './bulkProjects';

const proj = (id: string, name: string): Project => ({ id, name, color: '#000', isArchived: false });

describe('planBulkProjects', () => {
  it('makes one project per folder, named after it, each linked, with different colours', () => {
    const r = planBulkProjects([proj('p0', 'General')], [], ['E:\\Projects\\hims', 'E:\\Projects\\dcim'], 1000);
    expect(r.projects.map((p) => p.name)).toEqual(['General', 'hims', 'dcim']);
    expect(r.folders.map((f) => f.path)).toEqual(['E:\\Projects\\hims', 'E:\\Projects\\dcim']);
    expect(new Set(r.projects.map((p) => p.id)).size).toBe(3);
    expect(r.projects[1].color).not.toBe(r.projects[2].color);
    expect(r.created).toBe(2);
    expect(bulkMessage(r)).toBe('2 projects added.');
  });

  it('reuses a project with the same name and skips a folder that is already linked', () => {
    const projects = [proj('p1', 'hims'), proj('p2', 'dcim')];
    const folders = [{ path: 'E:\\Projects\\dcim', projectId: 'p2' }];
    const r = planBulkProjects(projects, folders, ['E:\\Projects\\hims', 'E:\\Projects\\dcim'], 1);
    expect(r.created).toBe(0);
    expect(r.reused).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].path).toBe('E:\\Projects\\dcim');
    expect(r.folders).toHaveLength(2);
    expect(bulkMessage(r)).toBe('1 folder linked to a project you already had, 1 skipped.');
  });

  it('reports a path that is not a full path, and says so when nothing was added', () => {
    const r = planBulkProjects([], [], ['relative\\path'], 1);
    expect(r.skipped).toHaveLength(1);
    expect(bulkMessage(r)).toBe('1 skipped.');
    expect(bulkMessage(planBulkProjects([], [], [], 1))).toBe('Nothing was added.');
  });
});
