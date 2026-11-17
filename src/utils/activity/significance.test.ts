process.env.TZ = 'Asia/Dhaka';

import { describe, it, expect } from 'vitest';
import { isNoise, scoreCluster, mergeMaybe, logThreshold, type MaybeCluster } from './significance';
import type { ActivityItem, ItemSource } from './types';

let n = 0;
const mkItem = (id: string, text: string, source: ItemSource = 'git'): ActivityItem => ({
  id,
  source,
  folder: '/p',
  time: '2026-11-09T04:00:00.000Z',
  text,
});
const commit = (text: string) => mkItem(`git:${++n}`, text);
const prompt = (text: string) => mkItem(`claude:s:${++n}`, text, 'claude');

describe('isNoise', () => {
  it.each([
    'Merge branch main into x',
    'Merge pull request #4',
    'wip',
    'WIP: login',
    'typo',
    'fix typo',
    'Fix typo in readme',
    'bump version',
    'Bump version to 1.0.8',
    'update lockfile',
    'format',
    'lint',
    'prettier',
    'chore: format',
    'style: prettier',
  ])('commit "%s" is noise', (t) => expect(isNoise(commit(t))).toBe(true));
  it.each(['Add login form', 'Fix payment rounding bug', 'feat(ui): add date picker', 'Formatter for dates in export'])(
    'commit "%s" is not noise',
    (t) => expect(isNoise(commit(t))).toBe(false),
  );
  it.each(['yes', 'ok', 'continue', 'go ahead', 'thanks', 'Thanks!', '/clear', '/compact now please do it', 'short one', ''])(
    'prompt "%s" is noise',
    (t) => expect(isNoise(prompt(t))).toBe(true),
  );
  it('keeps real prompts', () => expect(isNoise(prompt('Refactor the pagination hook to use cursors'))).toBe(false));
  it('Session titles are never noise', () => {
    expect(isNoise(prompt('Session: fix'))).toBe(false);
    expect(isNoise(mkItem('opencode:a:b', 'Session: x', 'opencode'))).toBe(false);
  });
  it('wip, doc and task items are not noise', () => {
    expect(isNoise(mkItem('wip:2026-11-09:abc', 'Uncommitted changes'))).toBe(false);
    expect(isNoise(mkItem('doc:2026-11-09:abc', 'a.docx', 'docs'))).toBe(false);
    expect(isNoise(mkItem('task:t1', 'x', 'task'))).toBe(false);
  });
});

describe('scoreCluster', () => {
  const realCommit = () => commit('Add export menu');
  const realPrompt = () => prompt('Please add an export menu to history');
  it('skips empty and noise-only', () => {
    expect(scoreCluster({ items: [], minutes: 0 }).level).toBe('skip');
    const r = scoreCluster({ items: [commit('wip'), prompt('yes')], minutes: 40 });
    expect(r.level).toBe('skip');
    expect(r.reasons).toContain('only noise');
  });
  it('done task is always log', () => {
    expect(scoreCluster({ items: [mkItem('task:1', 'Ship it', 'task')], minutes: 0 }).level).toBe('log');
  });
  it('commit at exactly the threshold is log, one minute below is maybe', () => {
    expect(scoreCluster({ items: [realCommit()], minutes: 15 }).level).toBe('log');
    expect(scoreCluster({ items: [realCommit()], minutes: 14 }).level).toBe('maybe');
  });
  it('two items at the threshold are log, one prompt is maybe', () => {
    expect(scoreCluster({ items: [realPrompt(), realPrompt()], minutes: 15 }).level).toBe('log');
    expect(scoreCluster({ items: [realPrompt()], minutes: 60 }).level).toBe('maybe');
  });
  it('small but meaningful is maybe, tiny uncommitted is maybe', () => {
    expect(scoreCluster({ items: [realPrompt()], minutes: 5 }).level).toBe('maybe');
    expect(scoreCluster({ items: [mkItem('wip:d:h', 'Uncommitted changes')], minutes: 0 }).level).toBe('maybe');
  });
  it('detail scales the threshold', () => {
    const c = { items: [realCommit()], minutes: 10 };
    expect(scoreCluster(c, { detail: 'detailed' }).level).toBe('log');
    expect(scoreCluster(c, { detail: 'normal' }).level).toBe('maybe');
    expect(scoreCluster({ items: [realCommit()], minutes: 29 }, { detail: 'brief' }).level).toBe('maybe');
    expect(scoreCluster({ items: [realCommit()], minutes: 30 }, { detail: 'brief' }).level).toBe('log');
    expect(logThreshold({ smallestLogMinutes: 20, detail: 'brief', boost: 1.5 })).toBe(60);
  });
  it('boost raises the bar', () => {
    expect(scoreCluster({ items: [realCommit()], minutes: 15 }, { boost: 2 }).level).toBe('maybe');
  });
  it('more evidence scores higher', () => {
    const a = scoreCluster({ items: [realCommit()], minutes: 15 }).score;
    const b = scoreCluster({ items: [realCommit(), realPrompt()], minutes: 15 }).score;
    expect(b).toBeGreaterThan(a);
  });
});

describe('mergeMaybe', () => {
  const mk = (projectId: string, ids: string[], minutes: number): MaybeCluster => ({
    projectId,
    minutes,
    items: ids.map((id) => mkItem(`claude:s:${id}`, 'A real prompt text here', 'claude')),
  });
  it('adds minutes and items for the same project, and can cross the threshold', () => {
    const merged = mergeMaybe([mk('p', ['a'], 8)], [mk('p', ['b'], 9)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].minutes).toBe(17);
    expect(merged[0].items).toHaveLength(2);
    expect(scoreCluster(merged[0]).level).toBe('log');
  });
  it('keeps other projects apart and handles empty', () => {
    expect(mergeMaybe([mk('p', ['a'], 5)], [mk('q', ['b'], 5)])).toHaveLength(2);
    expect(mergeMaybe([], [])).toEqual([]);
    expect(mergeMaybe([mk('p', ['a'], 5)], [])).toHaveLength(1);
  });
  it('does not double count items seen again', () => {
    const merged = mergeMaybe([mk('p', ['a'], 8)], [mk('p', ['a', 'b'], 10)]);
    expect(merged[0].items).toHaveLength(2);
    expect(merged[0].minutes).toBe(13);
    expect(mergeMaybe([mk('p', ['a'], 8)], [mk('p', ['a'], 8)])[0].minutes).toBe(8);
  });
  it('does not change its inputs', () => {
    const prev = [mk('p', ['a'], 8)];
    mergeMaybe(prev, [mk('p', ['b'], 9)]);
    expect(prev[0].minutes).toBe(8);
    expect(prev[0].items).toHaveLength(1);
  });
});
