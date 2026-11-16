import { describe, it, expect } from 'vitest';
import { addActivityFolder, isFullFolderPath, sourcesFromSettings, activityFieldsFromSources, aiFromSettings, aiField } from './settings';

describe('isFullFolderPath', () => {
  it.each(['E:\\projects\\app', 'e:/work/x', 'C:\\', '/home/me/app', '  E:\\a  '])('accepts %s', (p) => {
    expect(isFullFolderPath(p)).toBe(true);
  });
  it.each(['', '   ', 'app', 'projects\\app', './app', '..\\app', 'E:app'])('rejects %s', (p) => {
    expect(isFullFolderPath(p)).toBe(false);
  });
});

describe('addActivityFolder', () => {
  it('adds a trimmed path with its project', () => {
    const r = addActivityFolder([], '  E:\\projects\\app  ', 'proj-a');
    expect(r).toEqual({ ok: true, folders: [{ path: 'E:\\projects\\app', projectId: 'proj-a' }] });
  });
  it('drops a trailing slash but keeps a drive root', () => {
    expect(addActivityFolder([], 'E:\\projects\\app\\', 'p')).toMatchObject({ ok: true, folders: [{ path: 'E:\\projects\\app' }] });
    expect(addActivityFolder([], 'E:\\', 'p')).toMatchObject({ ok: true, folders: [{ path: 'E:\\' }] });
  });
  it('explains a path that is not a full path in one plain sentence', () => {
    const r = addActivityFolder([], 'app', 'p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Enter the full folder path, like E:\\projects\\app.');
  });
  it('refuses a folder that is already listed, ignoring case and slash style', () => {
    const existing = [{ path: 'E:\\Projects\\App', projectId: 'p' }];
    const r = addActivityFolder(existing, 'e:/projects/app/', 'q');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already/i);
  });
  it('refuses to add without a project', () => {
    const r = addActivityFolder([], 'E:\\a', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/project/i);
  });
});

describe('sourcesFromSettings / activityFieldsFromSources', () => {
  it('has every source on by default', () => {
    expect(sourcesFromSettings({})).toEqual({ claude: true, git: true, opencode: true, codex: true });
    expect(sourcesFromSettings({ activityUseClaude: false })).toEqual({ claude: false, git: true, opencode: true, codex: true });
    expect(sourcesFromSettings({ activityUseCodex: false, activityUseOpenCode: false })).toEqual({ claude: true, git: true, opencode: false, codex: false });
  });
  it('reads explicit choices', () => {
    expect(sourcesFromSettings({ activityUseClaude: true, activityUseGit: false })).toEqual({ claude: true, git: false, opencode: true, codex: true });
  });
  it('stores only what differs from the defaults', () => {
    expect(activityFieldsFromSources({ claude: true, git: true })).toEqual({ activityUseClaude: undefined, activityUseGit: undefined, activityUseOpenCode: undefined, activityUseCodex: undefined });
    expect(activityFieldsFromSources({ claude: false, git: false, opencode: false, codex: false })).toEqual({ activityUseClaude: false, activityUseGit: false, activityUseOpenCode: false, activityUseCodex: false });
  });
  it('round-trips', () => {
    for (const claude of [true, false]) for (const git of [true, false]) for (const codex of [true, false]) {
      const s = { claude, git, opencode: !codex, codex };
      expect(sourcesFromSettings(activityFieldsFromSources(s))).toEqual(s);
    }
  });
});

describe('aiFromSettings / aiField', () => {
  it('uses Claude Code unless another choice was saved', () => {
    expect(aiFromSettings({})).toBe('claude');
    expect(aiFromSettings({ activityAi: 'gemini' })).toBe('gemini');
    expect(aiFromSettings({ activityAi: 'none' })).toBe('none');
  });
  it('stores only a choice that differs from the default', () => {
    expect(aiField('claude')).toBeUndefined();
    expect(aiField('gemini')).toBe('gemini');
    expect(aiField('none')).toBe('none');
  });
  it('round-trips', () => {
    for (const ai of ['claude', 'gemini', 'none'] as const) expect(aiFromSettings({ activityAi: aiField(ai) })).toBe(ai);
  });
});
