import { describe, expect, it } from 'vitest';
import { autoProjectsEnabled, foldersWithRealWork, unlinkedRepos, watchFolderOf } from './autoProjects';
import type { ActivityItem } from './types';

const item = (folder: string, source: ActivityItem['source'], text = 'x', n = 0): ActivityItem => ({ id: `${source}:${n}`, source, folder, time: '2026-11-16T05:00:00Z', text });

describe('watchFolderOf', () => {
  it('uses the folder set in Settings', () => {
    expect(watchFolderOf({ activityWatchFolder: 'E:\\Work' })).toBe('E:\\Work');
  });
  it('else the common parent of the linked folders', () => {
    expect(watchFolderOf({ activityFolders: [{ path: 'E:\\Projects\\a', projectId: '1' }, { path: 'E:\\Projects\\b', projectId: '2' }] })).toBe('E:\\Projects');
  });
  it('is null when nothing says where, or the linked folders live in different places', () => {
    expect(watchFolderOf({})).toBeNull();
    expect(watchFolderOf({ activityFolders: [{ path: 'E:\\a\\x', projectId: '1' }, { path: 'D:\\b\\y', projectId: '2' }] })).toBeNull();
    expect(watchFolderOf({ activityFolders: [{ path: 'E:\\only', projectId: '1' }] })).toBeNull();
  });
});

describe('unlinkedRepos', () => {
  it('drops repos inside a linked folder and ignored ones', () => {
    const linked = [{ path: 'E:\\Projects\\a', projectId: '1' }];
    expect(unlinkedRepos(['E:\\Projects\\a', 'E:\\Projects\\a\\sub', 'E:\\Projects\\b', 'E:\\Projects\\c'], linked, ['e:/projects/c'])).toEqual(['E:\\Projects\\b']);
  });
});

describe('foldersWithRealWork', () => {
  it('counts commits, uncommitted changes and documents, and needs two prompts', () => {
    const items = [
      item('F1', 'git'),
      item('F2', 'docs'),
      item('F3', 'claude', 'one prompt', 1),
      item('F4', 'codex', 'p1', 1),
      item('F4', 'codex', 'p2', 2),
      item('F5', 'claude', 'Session: title', 1),
      item('F5', 'claude', 'Edited a.ts', 2),
    ];
    expect(foldersWithRealWork(items).sort()).toEqual(['F1', 'F2', 'F4']);
  });
});

describe('autoProjectsEnabled', () => {
  it('is on unless switched off', () => {
    expect(autoProjectsEnabled({})).toBe(true);
    expect(autoProjectsEnabled({ activityAutoProjects: false })).toBe(false);
  });
});
