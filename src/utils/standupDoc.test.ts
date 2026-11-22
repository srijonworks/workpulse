import { describe, expect, it } from 'vitest';
import { createScriptHarness } from '../test/appsScriptHarness';
import { isNothing, parseStandup } from './standupDoc';
import { standupEntries } from './standup';
import { generateFallbackTemplate } from './aiGenerator';
import type { BacklogTask, WorkLog } from '../types';

// The app (parseStandup) and the email script (standupDoc_) must read every standup the same way, so it looks the same in
// History and in the emails. Each sample goes through both.

const SAMPLES: Record<string, string> = {
  'sub-points and a repeated project': `*What I completed today:*
- *hims:* Made HMIS stateless
  - Complaint delivery runs once per complaint
  - Shared rate limits across copies
- *idim:* Fixed Comm Store issues
- *HIMS:* Built an async outbox
    - Limited to Dhaka

*In progress / Rolling over:*
- *hims:* CHUADANGA stock stays stale

*Blockers / Waiting on:*
- None`,
  'an older standup: bullets with "•", a title line, no sub-points': `*Daily Standup — Thu, Nov 19*

*What I completed today:*
• [hims] Fixed login
• [idim] Report

*In progress / Rolling over:*
• No ongoing tasks in flight

*Blockers / Waiting on:*
• None`,
  'markdown headings, numbered points, plain lines and an emoji heading': `# Summary
Quiet day.
1. *wp:* Shipped 1.0.25
2) Wrote docs

🚀 *Next:*
- Plan the week`,
  'text before any heading, a sub-point with no point above, tabs': `Hello team,
  - stray indented bullet
- *hims:* Main
\t- tab sub-point`,
};

describe('standup structure: app and email read the same', () => {
  const h = createScriptHarness();
  for (const [name, text] of Object.entries(SAMPLES)) {
    it(name, () => {
      const app = parseStandup(text);
      const email = h.run('standupDoc_', text);
      expect(JSON.parse(JSON.stringify(email))).toEqual(app);
    });
  }
});

describe('parseStandup', () => {
  it('puts sub-points under the point above and gathers a project once per section, any case', () => {
    const [done, doing, blocked] = parseStandup(SAMPLES['sub-points and a repeated project']);
    expect(done).toMatchObject({ title: 'What I completed today:', kind: 'done' });
    expect(done.items).toEqual([
      {
        kind: 'project',
        label: 'hims',
        points: [
          { text: 'Made HMIS stateless', subs: ['Complaint delivery runs once per complaint', 'Shared rate limits across copies'] },
          { text: 'Built an async outbox', subs: ['Limited to Dhaka'] },
        ],
      },
      { kind: 'project', label: 'idim', points: [{ text: 'Fixed Comm Store issues', subs: [] }] },
    ]);
    expect(doing.kind).toBe('doing');
    expect(blocked).toMatchObject({ kind: 'blocked', items: [{ kind: 'point', point: { text: 'None', subs: [] } }] });
  });

  it('keeps an indented bullet with no point above as a point, and reads a tab as an indent', () => {
    const [sec] = parseStandup(SAMPLES['text before any heading, a sub-point with no point above, tabs']);
    expect(sec.title).toBe('');
    expect(sec.items[1]).toEqual({ kind: 'point', point: { text: 'stray indented bullet', subs: [] } });
    expect(sec.items[2]).toEqual({ kind: 'project', label: 'hims', points: [{ text: 'Main', subs: ['tab sub-point'] }] });
  });

  it('knows "None" and the like', () => {
    expect(['None', 'none.', 'N/A', '*None*'].every(isNothing)).toBe(true);
    expect(isNothing('None of the tests failed')).toBe(false);
  });
});

describe('the standup is written from logs and done tasks together', () => {
  const projects = [{ id: 'p1', name: 'hims', color: '#d4a72c', isArchived: false }];
  const log = (id: string, description: string, extra: Partial<WorkLog> = {}): WorkLog => ({
    id, date: '2026-11-19', time: '10:00', projectId: 'p1', projectName: 'hims', description, status: 'completed', tags: [], createdAt: 'c', ...extra,
  });
  const task = (id: string, title: string, extra: Partial<BacklogTask> = {}): BacklogTask => ({
    id, title, projectId: 'p1', dueDate: '2026-11-19', completed: true, stage: 'done', completedAt: '2026-11-19T08:00:00.000Z', elapsedSeconds: 1800, ...extra,
  } as BacklogTask);

  it('adds done tasks no log covers, once', () => {
    const entries = standupEntries({
      logs: [log('l1', 'Made HMIS stateless', { sourceIds: ['task:t1'] }), log('l2', 'Outbox', { underlyingTasks: [{ id: 't2', title: 'x', stage: 'done', elapsedSeconds: 0 }] })],
      tasks: [task('t1', 'Stateless'), task('t2', 'Outbox table'), task('t3', 'made hmis stateless'), task('t4', 'Fix the voucher bug'), task('t5', 'Old', { completedAt: '2026-11-10T08:00:00.000Z' })],
      projects, from: '2026-11-19', to: '2026-11-19',
    });
    expect(entries.map((e) => e.description)).toEqual(['Made HMIS stateless', 'Outbox', 'Fix the voucher bug']);
    expect(entries[2]).toMatchObject({ id: 'task:t4', projectName: 'hims', durationMinutes: 30, status: 'completed' });
  });

  it('the plain template uses the shared format, with sub-tasks as sub-points', () => {
    const text = generateFallbackTemplate(
      [log('l1', 'Made HMIS stateless', { underlyingTasks: [{ id: 'a', title: 'Shared rate limits', stage: 'done', elapsedSeconds: 0 }] })],
      'slack', 'casual', undefined, 'Thu, Nov 19',
    );
    const [, done, doing] = parseStandup(text);
    expect(done).toMatchObject({ title: 'What I completed today:', kind: 'done' });
    expect(done.items).toEqual([{ kind: 'project', label: 'hims', points: [{ text: 'Made HMIS stateless', subs: ['Shared rate limits'] }] }]);
    expect(doing.items).toEqual([{ kind: 'point', point: { text: 'None', subs: [] } }]);
    expect(generateFallbackTemplate([log('l1', 'x')], 'slack', 'casual', undefined, 'week of Fri, Nov 13 to Thu, Nov 19')).toContain('*What I completed this week:*');
  });
});
