import { clip, redactSecrets } from './sanitize';
import type { ActivityItem, AiTask } from './types';

const PER_FOLDER_CAP = 40;
const ITEM_TEXT_MAX = 200;
const OTHER_TEXT = 'Other activity';
const MAX_SUBTASKS = 12;

/** The shape the AI must answer with: { tasks: [{ text, subtasks[], itemIds[] }] }. */
export const ACTIVITY_TASKS_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          subtasks: { type: 'array', items: { type: 'string' } },
          itemIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'subtasks', 'itemIds'],
      },
    },
  },
  required: ['tasks'],
};

// Models sometimes leave the short ids in the sentence: "fixed the drift [i1] and ([i2]) tests".
const cleanText = (text: string): string =>
  text.replace(/\s*\(?\[i\d+\]\)?/g, '').replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

const SYSTEM_INSTRUCTION = `You turn a developer's raw activity for one day into work-log entries.

You are given activity items, each with a short id in square brackets (like [i3]), grouped by project.

HOW TO GROUP:
1. Write ONE task per project. Everything done in a project that is related (fixes, features, tests, docs, review, follow-up changes) belongs in that one task, however many commits or prompts it came from.
2. Write a second task for the same project ONLY when some work is totally unrelated to the rest: a different feature or area with a different goal, which could not honestly share one log line. When in doubt, keep it together.
3. "text": one or two plain sentences in the past tense that summarise the whole task.
4. "subtasks": 2 to 8 short past-tense steps (at most 10 words each) saying what was done inside the task, for example "Fixed the timer drift on the Tasks screen". Merge near-duplicates. Do not copy prompts word for word.
5. Items marked (done task) are tasks the user finished and timed. Keep each as a step in the project's log (use its wording), and add the commits and prompts that belong to the same work as steps of that same log; work that matches no task is still a step of the project's log, never a separate log of its own unless it is totally unrelated.
6. Prompts that are only confirmations or small talk ("yes", "go ahead", "ok", "continue", "thanks") are trivial: do not mention them and leave their ids out.

RULES:
7. Refer to items ONLY by their short ids, in "itemIds". Never invent ids.
8. Do NOT state any duration, time or number of minutes, and do NOT name or choose a project. The app works those out.
9. No markdown, no bullet characters, no raw commit hashes, no file contents.
10. Do not write the item ids in the text or the subtasks: ids belong only in "itemIds".

Respond with valid JSON only, in exactly this shape:
{ "tasks": [ { "text": "string", "subtasks": ["string"], "itemIds": ["i1", "i2"] } ] }`;

/**
 * The prompt sent to Gemini. Each item is given a short id (i1, i2, ...) so the model can group
 * items without ever handling the real ids; `shortToId` maps them back. Text is redacted and
 * clipped again here as a safety net, and a folder contributes at most its 40 latest items.
 */
export function buildActivityPrompt(
  items: ActivityItem[],
  projectNameByFolder: Record<string, string>,
): { systemInstruction: string; userPrompt: string; shortToId: Record<string, string> } {
  const byFolder = new Map<string, ActivityItem[]>();
  for (const it of items) byFolder.set(it.folder, [...(byFolder.get(it.folder) ?? []), it]);

  // Cap each folder first (latest items win), then group folders that share a project name.
  const byProject = new Map<string, ActivityItem[]>();
  for (const [folder, list] of byFolder) {
    const kept = [...list].sort((a, b) => b.time.localeCompare(a.time)).slice(0, PER_FOLDER_CAP).reverse();
    const name = projectNameByFolder[folder] || baseName(folder);
    byProject.set(name, [...(byProject.get(name) ?? []), ...kept]);
  }

  const shortToId: Record<string, string> = {};
  let n = 0;
  const sections: string[] = [];
  for (const [name, list] of byProject) {
    const rows = [...list]
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((it) => {
        const short = `i${++n}`;
        shortToId[short] = it.id;
        const kind = it.source === 'git' ? 'commit' : it.source === 'task' ? 'done task' : it.source === 'opencode' ? 'opencode' : it.source === 'codex' ? 'codex' : 'claude';
        return `[${short}] (${kind}) ${clip(redactSecrets(it.text), ITEM_TEXT_MAX)}`;
      });
    sections.push(`Project: ${name}\n${rows.join('\n')}`);
  }

  return {
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt: `Group this activity into work-log tasks.\n\n${sections.join('\n\n')}`,
    shortToId,
  };
}

// The steps the AI listed: cleaned, de-duplicated, at most 12. Undefined when there are none.
function cleanSubtasks(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    const text = typeof entry === 'string' ? cleanText(entry) : '';
    if (text && !out.includes(text)) out.push(text);
  }
  return out.length > 0 ? out.slice(0, MAX_SUBTASKS) : undefined;
}

/**
 * Reads the model's answer defensively. Unknown ids are ignored, an id counts only in the first
 * task that cites it, tasks left without text or ids are dropped, and anything the model did not
 * place (or that was never sent) becomes one "Other activity" task, so nothing is silently lost.
 */
export function parseAiTasks(raw: unknown, shortToId: Record<string, string>, items: ActivityItem[]): AiTask[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const used = new Set<string>();
  const tasks: AiTask[] = [];

  const list = (raw as { tasks?: unknown } | null)?.tasks;
  if (Array.isArray(list)) {
    for (const t of list) {
      const text = typeof t?.text === 'string' ? cleanText(t.text) : '';
      if (!text || !Array.isArray(t?.itemIds)) continue;
      const ids: string[] = [];
      for (const short of t.itemIds) {
        const real = typeof short === 'string' ? shortToId[short] : undefined;
        if (real && byId.has(real) && !used.has(real)) {
          used.add(real);
          ids.push(real);
        }
      }
      if (ids.length === 0) continue;
      const subtasks = cleanSubtasks(t.subtasks);
      tasks.push(subtasks ? { text, subtasks, itemIds: ids } : { text, itemIds: ids });
    }
  }

  // Items the AI did not place (trivial prompts, or items cut by the per-folder cap) are not shown as
  // rows of their own: they join the task that holds most of their folder, so their time still counts
  // and they are not suggested again. A folder with no task at all gets one "Other activity" task.
  const otherByFolder = new Map<string, string[]>();
  for (const item of items) {
    if (used.has(item.id)) continue;
    let best = -1;
    let bestCount = 0;
    tasks.forEach((task, index) => {
      const count = task.itemIds.filter((id) => byId.get(id)?.folder === item.folder).length;
      if (count > bestCount) {
        best = index;
        bestCount = count;
      }
    });
    if (best >= 0) tasks[best].itemIds.push(item.id);
    else otherByFolder.set(item.folder, [...(otherByFolder.get(item.folder) ?? []), item.id]);
  }
  for (const ids of otherByFolder.values()) tasks.push({ text: OTHER_TEXT, itemIds: ids });
  return tasks;
}
