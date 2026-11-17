import { describe as suite, it, expect } from 'vitest';
import { ACTIVITY_SOURCES, ACTIVITY_SOURCE_IDS, anyPromptSourceOn, byDisplayRank, describe, isPromptLike, type SourceDescriptor } from './registry';
import { describeSources, noticeSignature } from './pipeline';
import { activityFieldsFromSources, sourcesFromSettings } from './settings';
import { READERS } from '../../server/readers';

const fake: SourceDescriptor = {
  id: 'fake',
  label: 'Fake tool prompts',
  settingKey: 'activityUseFake' as SourceDescriptor['settingKey'],
  kind: 'prompts',
  short: 'Fake',
  noticeLine: (ai) => `Fake goes to ${ai}.`,
  settingsText: { title: 'Include Fake', description: 'x' },
  evidence: (n) => `${n} fake`,
  countSessions: false,
  promptLike: true,
  aiKind: 'fake',
  displayRank: 9,
};
const withFake = [...ACTIVITY_SOURCES, fake];

suite('registry', () => {
  it('has the five known sources with their existing settings keys', () => {
    expect(ACTIVITY_SOURCE_IDS).toEqual(['claude', 'git', 'opencode', 'codex', 'docs']);
    expect(ACTIVITY_SOURCES.map((d) => d.settingKey)).toEqual(['activityUseClaude', 'activityUseGit', 'activityUseOpenCode', 'activityUseCodex', 'activityUseDocs']);
  });
  it('has a server reader for every id', () => {
    expect(Object.keys(READERS).sort()).toEqual([...ACTIVITY_SOURCE_IDS].sort());
  });
  it('looks up, ranks and classifies', () => {
    expect(describe('git')?.label).toBe('Git commits');
    expect(describe('task')).toBeUndefined();
    expect(byDisplayRank().map((d) => d.id)).toEqual(['git', 'claude', 'opencode', 'codex', 'docs']);
    expect(isPromptLike('codex')).toBe(true);
    expect(isPromptLike('git')).toBe(false);
    expect(anyPromptSourceOn({ git: true, docs: true })).toBe(false);
    expect(anyPromptSourceOn({ git: true, codex: true })).toBe(true);
  });
  it('words evidence as before', () => {
    expect(describe('claude')!.evidence(1)).toBe('1 Claude session');
    expect(describe('git')!.evidence(3)).toBe('3 commits');
    expect(describe('docs')!.evidence(2)).toBe('2 documents');
  });
  it('keeps the consent signature unchanged', () => {
    expect(noticeSignature({ claude: true, git: true, opencode: true, codex: true, docs: true }, 'claude')).toBe('git+claude+opencode+codex+docs|claude');
    expect(noticeSignature({ claude: true, git: true }, 'claude')).toBe('git+claude|claude');
    expect(noticeSignature({ claude: false, git: false }, 'gemini')).toBe('|gemini');
  });
  it('lets an extra descriptor flow through the helpers', () => {
    expect(sourcesFromSettings({ activityUseFake: false } as never, withFake)).toMatchObject({ fake: false, git: true });
    expect(activityFieldsFromSources({ fake: false } as never, withFake)).toMatchObject({ activityUseFake: false, activityUseGit: undefined });
    expect(describeSources({ fake: true } as never, { fake: { ok: true, count: 2 } } as never, withFake)).toEqual(['Fake tool prompts: 2 found.']);
    expect(noticeSignature({ git: true, fake: true } as never, 'claude', withFake)).toBe('git+fake|claude');
  });
});
