process.env.TZ = 'Asia/Dhaka';

import { describe, it, expect, vi } from 'vitest';
import { loadSuggestions, describeSources, noticeSignature } from './pipeline';
import type { ActivityItem, ScanResponse } from './types';
import type { Project, WorkLog } from '../../types';

const DATE = '2026-11-09';
const item = (id: string, time: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id, source: 'git', folder: '/p/app', time, text: `work ${id}`, ...over,
});
const ok = { ok: true, count: 0 };
const scanOf = (items: ActivityItem[], status: Partial<ScanResponse['status']> = {}): ScanResponse => ({
  items,
  status: { claude: { ok: true, count: 0, note: 'Turned off in Settings' }, git: { ok: true, count: items.length }, ...status },
});
const projects: Project[] = [{ id: 'proj-a', name: 'Alpha', color: '#fff', isArchived: false }];
const base = {
  date: DATE,
  folders: [{ path: '/p/app', projectId: 'proj-a' }],
  sources: { claude: false, git: true },
  projects,
  logs: [] as WorkLog[],
  backlog: [],
  geminiApiKey: 'k',
  ai: 'claude' as const,
};
const items = [item('git:1', '2026-11-09T04:00:00.000Z'), item('git:2', '2026-11-09T04:10:00.000Z')];

describe('loadSuggestions with quality filtering', () => {
  const longItems = [item('git:1', '2026-11-09T04:00:00.000Z', { text: 'Add export button' }), item('git:2', '2026-11-09T04:20:00.000Z', { text: 'Wire export to History' })];
  const noop = vi.fn();

  it('without it, every suggestion comes back as before', async () => {
    const r = await loadSuggestions({ ...base, ai: 'none' }, { scan: vi.fn().mockResolvedValue(scanOf(items)), suggest: noop });
    expect(r.suggestions).toHaveLength(1);
    expect(r.maybe).toBeUndefined();
  });

  it('keeps work of 15 minutes or more as a log', async () => {
    const r = await loadSuggestions({ ...base, ai: 'none', quality: {} }, { scan: vi.fn().mockResolvedValue(scanOf(longItems)), suggest: noop });
    expect(r.suggestions).toHaveLength(1);
    expect(r.maybe).toEqual([]);
  });

  it('puts small work in "maybe" and counts trivial items as skipped, and never sends them to the AI', async () => {
    const small = [item('git:1', '2026-11-09T04:00:00.000Z', { text: 'fix null check' }), item('git:9', '2026-11-09T04:01:00.000Z', { text: 'Merge branch main' })];
    const suggest = vi.fn();
    const r = await loadSuggestions({ ...base, ai: 'none', quality: { smallestLogMinutes: 15 } }, { scan: vi.fn().mockResolvedValue(scanOf(small)), suggest });
    expect(r.suggestions).toHaveLength(0);
    expect(r.maybe).toHaveLength(1);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.maybe![0].itemIds).toEqual(['git:1']);
  });

  it('a lower smallest log turns the same work into a log', async () => {
    const small = [item('git:1', '2026-11-09T04:00:00.000Z', { text: 'fix null check' })];
    const r = await loadSuggestions({ ...base, ai: 'none', quality: { smallestLogMinutes: 1 } }, { scan: vi.fn().mockResolvedValue(scanOf(small)), suggest: noop });
    expect(r.suggestions).toHaveLength(1);
  });

  it('a boost for a project raises the bar for it', async () => {
    const r = await loadSuggestions({ ...base, ai: 'none', quality: { smallestLogMinutes: 15, boostFor: () => 2 } }, { scan: vi.fn().mockResolvedValue(scanOf(longItems)), suggest: noop });
    expect(r.suggestions.length + (r.maybe?.length ?? 0)).toBe(1);
  });
});

describe('loadSuggestions', () => {
  it('scans, groups with the AI and builds suggestions', async () => {
    const scan = vi.fn().mockResolvedValue(scanOf(items));
    const suggest = vi.fn().mockResolvedValue({ tasks: [{ text: 'Did the thing', itemIds: ['git:1', 'git:2'] }] });
    const r = await loadSuggestions(base, { scan, suggest });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ text: 'Did the thing', projectName: 'Alpha', minutes: 10 });
    expect(scan).toHaveBeenCalledWith({ date: DATE, folders: base.folders, sources: base.sources });
    expect(suggest.mock.calls[0][0].projectNameByFolder).toEqual({ '/p/app': 'Alpha' });
    expect(suggest.mock.calls[0][0].provider).toBe('claude');
    expect(suggest.mock.calls[0][0].customApiKey).toBe(''); // the Gemini key is only sent when Gemini is the chosen AI
  });
  it('sends the Gemini key and provider when Gemini is chosen', async () => {
    const suggest = vi.fn().mockResolvedValue({ tasks: [{ text: 'T', itemIds: ['git:1', 'git:2'] }] });
    await loadSuggestions({ ...base, ai: 'gemini' }, { scan: vi.fn().mockResolvedValue(scanOf(items)), suggest });
    expect(suggest.mock.calls[0][0]).toMatchObject({ provider: 'gemini', customApiKey: 'k' });
  });
  it('writes plain wording without calling any AI when "none" is chosen', async () => {
    const suggest = vi.fn();
    const r = await loadSuggestions({ ...base, ai: 'none' }, { scan: vi.fn().mockResolvedValue(scanOf(items)), suggest });
    expect(suggest).not.toHaveBeenCalled();
    expect(r.notice).toBeUndefined();
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0].text).toBe('Worked on Alpha');
    expect(r.suggestions[0].subtasks).toEqual(['work git:1', 'work git:2']);
  });
  it('drops activity already used by a saved log before asking the AI', async () => {
    const used = { id: 'log-1', date: DATE, time: '10:00', projectId: 'proj-a', projectName: 'Alpha', description: 'x', status: 'completed', tags: [], createdAt: 'c', sourceIds: ['git:1'] } as WorkLog;
    const suggest = vi.fn().mockResolvedValue({ tasks: [{ text: 'T', itemIds: ['git:2'] }] });
    const r = await loadSuggestions({ ...base, logs: [used] }, { scan: vi.fn().mockResolvedValue(scanOf(items)), suggest });
    expect(suggest.mock.calls[0][0].items.map((i: ActivityItem) => i.id)).toEqual(['git:2']);
    expect(r.suggestions.flatMap((s) => s.itemIds)).toEqual(['git:2']);
  });
  it('does not call the AI when there is nothing new', async () => {
    const suggest = vi.fn();
    const r = await loadSuggestions(base, { scan: vi.fn().mockResolvedValue(scanOf([])), suggest });
    expect(suggest).not.toHaveBeenCalled();
    expect(r.suggestions).toEqual([]);
  });
  it('uses plain wording and keeps the server notice when the AI is unavailable', async () => {
    const suggest = vi.fn().mockResolvedValue({ tasks: null, notice: 'No Gemini key: using plain wording.' });
    const r = await loadSuggestions(base, { scan: vi.fn().mockResolvedValue(scanOf(items)), suggest });
    expect(r.notice).toBe('No Gemini key: using plain wording.');
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0].text).toBe('Worked on Alpha');
    expect(r.suggestions[0].subtasks).toEqual(['work git:1', 'work git:2']);
  });
  it('falls back to plain wording with a plain sentence when the AI call itself fails', async () => {
    const suggest = vi.fn().mockRejectedValue(new Error('WorkPulse could not reach its server.'));
    const r = await loadSuggestions(base, { scan: vi.fn().mockResolvedValue(scanOf(items)), suggest });
    expect(r.suggestions).toHaveLength(1);
    expect(r.notice).toContain('WorkPulse could not reach its server.');
    expect(r.notice).toMatch(/plain wording/i);
  });
  it('lets a scan failure through for the dialog to show', async () => {
    const scan = vi.fn().mockRejectedValue(new Error('Folder not found: /p/app'));
    await expect(loadSuggestions(base, { scan, suggest: vi.fn() })).rejects.toThrow('Folder not found');
  });
  it('returns the per-source status for the dialog', async () => {
    const r = await loadSuggestions(base, { scan: vi.fn().mockResolvedValue(scanOf([])), suggest: vi.fn() });
    expect(r.status.git).toEqual({ ok: true, count: 0 });
  });
});

describe('describeSources', () => {
  it('lists only switched-on sources with counts and notes', () => {
    const lines = describeSources(
      { claude: false, git: true },
      { claude: ok, git: { ok: true, count: 3, note: 'git user.name is not set in /p/app: showing commits from all authors' } },
    );
    expect(lines).toEqual([
      'Git commits: 3 found. git user.name is not set in /p/app: showing commits from all authors',
    ]);
  });
  it('says plainly when a source found nothing or could not be read', () => {
    const lines = describeSources(
      { claude: true, git: true },
      { claude: { ok: false, count: 0, note: "Couldn't read Claude Code history" }, git: { ok: true, count: 0 } },
    );
    expect(lines).toEqual(["Claude Code prompts: couldn't read. Couldn't read Claude Code history", 'Git commits: nothing found.']);
  });
});

describe('noticeSignature', () => {
  it('changes when a source is switched on, so the data notice is shown again', () => {
    expect(noticeSignature({ claude: false, git: true }, 'claude')).toBe('git|claude');
    expect(noticeSignature({ claude: true, git: true }, 'claude')).toBe('git+claude|claude');
    expect(noticeSignature({ claude: true, git: true, opencode: true, codex: true, docs: true }, 'claude')).toBe('git+claude+opencode+codex+docs|claude');
    expect(noticeSignature({ claude: false, git: false }, 'claude')).toBe('|claude');
  });
  it('changes when the AI is changed, because the data goes somewhere else', () => {
    const sources = { claude: false, git: true };
    expect(new Set([noticeSignature(sources, 'claude'), noticeSignature(sources, 'gemini'), noticeSignature(sources, 'none')]).size).toBe(3);
  });
});

describe('loadSuggestions with done tasks and background checks', () => {
  const doneTask = {
    id: 'tk1', title: 'Fix the filter', projectId: 'proj-a', dueDate: DATE, completed: true, stage: 'done' as const,
    originalDate: DATE, isRolledOver: false, elapsedSeconds: 30 * 60, completedAt: '2026-11-09T06:00:00.000Z',
  };
  it('merges done tasks into the same suggestions and sends them to the AI as items', async () => {
    const suggest = vi.fn().mockResolvedValue({ tasks: [{ text: 'Fixed the filter', itemIds: ['task:tk1', 'git:1', 'git:2'] }] });
    const r = await loadSuggestions({ ...base, tasks: [doneTask], backlog: [doneTask] }, { scan: vi.fn().mockResolvedValue(scanOf(items)), suggest });
    expect(suggest.mock.calls[0][0].items.map((i: ActivityItem) => i.id)).toContain('task:tk1');
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0].minutes).toBe(30);
  });
  it('works with done tasks alone: no folders means no scan', async () => {
    const scan = vi.fn();
    const suggest = vi.fn().mockResolvedValue({ tasks: [{ text: 'Done it', itemIds: ['task:tk1'] }] });
    const r = await loadSuggestions({ ...base, folders: [], tasks: [doneTask], backlog: [doneTask] }, { scan, suggest });
    expect(scan).not.toHaveBeenCalled();
    expect(r.suggestions).toHaveLength(1);
  });
  it('does not ask the AI again when nothing changed since the last check', async () => {
    const scan = vi.fn().mockResolvedValue(scanOf(items));
    const suggest = vi.fn().mockResolvedValue({ tasks: [{ text: 'T', itemIds: ['git:1', 'git:2'] }] });
    const first = await loadSuggestions(base, { scan, suggest });
    const again = await loadSuggestions({ ...base, sameAs: first.itemsKey }, { scan, suggest });
    expect(again.unchanged).toBe(true);
    expect(suggest).toHaveBeenCalledTimes(1);
    const more = await loadSuggestions({ ...base, sameAs: first.itemsKey }, { scan: vi.fn().mockResolvedValue(scanOf([...items, item('git:3', '2026-11-09T05:00:00.000Z')])), suggest });
    expect(more.unchanged).toBeUndefined();
    expect(suggest).toHaveBeenCalledTimes(2);
  });
});
