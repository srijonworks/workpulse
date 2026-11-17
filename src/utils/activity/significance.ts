import type { ActivityItem } from './types';

export type ClusterLevel = 'log' | 'maybe' | 'skip';
export type DetailLevel = 'brief' | 'normal' | 'detailed';

export interface ClusterScore {
  score: number;
  level: ClusterLevel;
  reasons: string[];
}

export interface ScoreOptions {
  /** Smallest worthwhile log in minutes before scaling (default 15). */
  smallestLogMinutes?: number;
  /** brief x2, normal x1, detailed x0.5 on the threshold. */
  detail?: DetailLevel;
  /** Extra multiplier on the threshold from learning (`thresholdBoost`), 1 = none. */
  boost?: number;
}

export const DEFAULT_SMALLEST_LOG_MINUTES = 15;
const MAYBE_MINUTES = 5;
const DETAIL_FACTOR: Record<DetailLevel, number> = { brief: 2, normal: 1, detailed: 0.5 };

const PROMPT_PREFIXES = ['claude:', 'opencode:', 'codex:'];
const TRIVIAL_PROMPT =
  /^(y|yes|yep|yeah|ok|okay|k|sure|continue|go ahead|go on|proceed|thanks|thank you|thx|do it|no|nope)(\s+please)?[\s.!?]*$/i;
const CONVENTIONAL_PREFIX = /^[a-z]+(\([^)]*\))?!?:\s*/i;
const NOISE_SUBJECT = [
  /^wip\b/,
  /^(fix(ed)?\s+)?typos?(\s+\S+){0,2}$/,
  /^bump(\s+\S+){0,3}$/,
  /^update\s+(the\s+)?(package-)?lock\s?files?\b/,
  /^(format|formatting|lint|linting|prettier)(\s+\S+){0,2}$/,
  /^merge\b/,
];

/** True for activity that should not count toward a log: merge/wip/typo-type commits and trivial prompts. */
export function isNoise(item: ActivityItem): boolean {
  const text = (item.text ?? '').trim();
  if (/^session:/i.test(text)) return false;
  if (item.id.startsWith('git:')) {
    const lower = text.toLowerCase();
    const stripped = lower.replace(CONVENTIONAL_PREFIX, '');
    return NOISE_SUBJECT.some((re) => re.test(lower) || re.test(stripped));
  }
  if (PROMPT_PREFIXES.some((p) => item.id.startsWith(p))) {
    if (text.startsWith('/')) return true;
    if (text.length < 12) return true;
    return TRIVIAL_PROMPT.test(text);
  }
  return false;
}

/** The minutes a cluster needs to be an automatic log. */
export function logThreshold(opts: ScoreOptions = {}): number {
  const base = opts.smallestLogMinutes ?? DEFAULT_SMALLEST_LOG_MINUTES;
  const factor = DETAIL_FACTOR[opts.detail ?? 'normal'] ?? 1;
  const boost = opts.boost && opts.boost > 0 ? opts.boost : 1;
  return base * factor * boost;
}

const isCommit = (i: ActivityItem) => i.id.startsWith('git:');
const isWip = (i: ActivityItem) => i.id.startsWith('wip:');
const isDoneTask = (i: ActivityItem) => i.source === 'task';

export function scoreCluster(
  cluster: { items: ActivityItem[]; minutes: number },
  opts: ScoreOptions = {},
): ClusterScore {
  const threshold = logThreshold(opts);
  const minutes = Math.max(0, cluster.minutes || 0);
  const all = cluster.items ?? [];
  const items = all.filter((i) => !isNoise(i));
  const commits = items.filter(isCommit).length;
  const wip = items.filter(isWip).length;
  const tasks = items.filter(isDoneTask).length;
  const sources = new Set(items.map((i) => i.source)).size;
  const others = items.length - commits - wip - tasks;
  const score = Math.round(
    minutes + commits * 10 + wip * 5 + others * 3 + tasks * 100 + Math.max(0, sources - 1) * 3,
  );

  const reasons: string[] = [];
  if (tasks > 0) reasons.push(`${tasks} done task${tasks === 1 ? '' : 's'}`);
  if (commits > 0) reasons.push(`${commits} commit${commits === 1 ? '' : 's'}`);
  if (wip > 0) reasons.push('uncommitted changes');
  if (sources > 1) reasons.push(`${sources} sources`);
  reasons.push(`~${minutes} min (needs ${threshold})`);
  if (items.length === 0 && all.length > 0) reasons.push('only noise');

  let level: ClusterLevel;
  if (tasks > 0) level = 'log';
  else if (items.length === 0) level = 'skip';
  else if (commits > 0 && minutes >= threshold) level = 'log';
  else if (minutes >= threshold && items.length >= 2) level = 'log';
  else if (minutes >= MAYBE_MINUTES || items.length >= 1) level = 'maybe';
  else level = 'skip';
  return { score, level, reasons };
}

export interface MaybeCluster {
  projectId: string;
  items: ActivityItem[];
  minutes: number;
}

/**
 * A Maybe keeps growing: later activity on the same project adds its minutes and items. Items already
 * held are not counted twice (a rescan returns them again): the new minutes are scaled to the fresh share.
 * Re-score the result with `scoreCluster` to see if it crossed the threshold.
 */
export function mergeMaybe(previousMaybe: MaybeCluster[], newMaybe: MaybeCluster[]): MaybeCluster[] {
  const out = (previousMaybe ?? []).map((c) => ({ ...c, items: [...c.items] }));
  for (const n of newMaybe ?? []) {
    const hit = out.find((c) => c.projectId === n.projectId);
    if (!hit) {
      out.push({ ...n, items: [...n.items] });
      continue;
    }
    const known = new Set(hit.items.map((i) => i.id));
    const fresh = n.items.filter((i) => !known.has(i.id));
    if (fresh.length === 0) continue;
    hit.items.push(...fresh);
    hit.minutes += Math.round((Math.max(0, n.minutes) * fresh.length) / n.items.length);
  }
  return out;
}
