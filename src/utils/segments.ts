import { BacklogTask, Project, WorkdayRecord } from '../types';
import { MAX_TICK_GAP_SECONDS } from './timer';

const SLOT_MS = 10 * 60_000;
const BALLS_PER_OVER = 6;
const UNASSIGNED_COLOR = '#8a8f98';

type Segment = { start: string; end?: string };

const hasOpenSegment = (segments: Segment[] | undefined): boolean => {
  const last = segments && segments[segments.length - 1];
  return !!last && last.end === undefined;
};

// Timer started: opens a segment unless one is already open.
export function startSegment(t: BacklogTask, nowIso: string): BacklogTask {
  if (hasOpenSegment(t.segments)) return t;
  return { ...t, segments: [...(t.segments ?? []), { start: nowIso }] };
}

// Timer stopped: closes the last open segment (no-op when none is open).
export function endSegment(t: BacklogTask, nowIso: string): BacklogTask {
  if (!t.segments || !hasOpenSegment(t.segments)) return t;
  const segments = t.segments.slice();
  segments[segments.length - 1] = { ...segments[segments.length - 1], end: nowIso };
  return { ...t, segments };
}

// Clock-out: every running task is paused at the clock-out time and stays paused until the user resumes it. When the clock-out
// is in the past (the automatic one, stamped at the last time the PC was in use), the seconds the clock counted after it, within
// the open segment, are taken back. Returns the same array when nothing was running.
export function pauseRunningAt(tasks: BacklogTask[], atIso: string, nowMs: number): BacklogTask[] {
  const atMs = Date.parse(atIso);
  if (!tasks.some((t) => t.stage === 'in_progress' || t.isRunning)) return tasks;
  return tasks.map((t) => {
    if (t.stage !== 'in_progress' && !t.isRunning) return t;
    const open = t.segments && hasOpenSegment(t.segments) ? Date.parse(t.segments[t.segments.length - 1].start) : NaN;
    const stopMs = Number.isFinite(open) ? Math.max(open, atMs) : atMs;
    const extra = Number.isFinite(stopMs) ? Math.max(0, Math.floor((nowMs - stopMs) / 1000)) : 0;
    const paused: BacklogTask = {
      ...t,
      stage: t.stage === 'in_progress' ? 'paused' : t.stage,
      isRunning: false,
      elapsedSeconds: Math.max(0, (t.elapsedSeconds || 0) - extra),
    };
    return endSegment(paused, Number.isFinite(stopMs) ? new Date(stopMs).toISOString() : new Date(nowMs).toISOString());
  });
}

// A running task with no open segment (its clock ran before segments existed) gets one starting now.
export function ensureOpenSegment(t: BacklogTask, nowIso: string): BacklogTask {
  return hasOpenSegment(t.segments) ? t : startSegment(t, nowIso);
}

// The computer slept (or the tab froze) between two timer ticks: the clocks add nothing for the gap
// (advanceClock), so the open segments must not span it either. Each open segment ends at the last
// tick and a new one starts now. Returns the same array when the gap is a normal tick.
export function splitSegmentsAtGap(
  tasks: BacklogTask[],
  lastTickMs: number,
  nowMs: number,
  maxGapSeconds = MAX_TICK_GAP_SECONDS,
): BacklogTask[] {
  if (nowMs - lastTickMs <= maxGapSeconds * 1000) return tasks;
  const lastIso = new Date(lastTickMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  let changed = false;
  const out = tasks.map((t) => {
    if (!hasOpenSegment(t.segments)) return t;
    changed = true;
    return startSegment(endSegment(t, lastIso), nowIso);
  });
  return changed ? out : tasks;
}

/**
 * Seconds the tasks' timers ran inside [fromMs, toMs): each segment is clipped to the range, an open
 * segment runs to `nowMs`. Overlapping segments (two timers at once) both count, like the task clocks do.
 */
export function segmentSecondsInRange(tasks: BacklogTask[], fromMs: number, toMs: number, nowMs: number): number {
  let ms = 0;
  for (const t of tasks) {
    for (const s of t.segments ?? []) {
      const a = Date.parse(s.start);
      const b = s.end ? Date.parse(s.end) : nowMs;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const lo = Math.max(a, fromMs);
      const hi = Math.min(b, toMs);
      if (hi > lo) ms += hi - lo;
    }
  }
  return Math.floor(ms / 1000);
}

export type Ball =
  | { kind: 'empty' }
  | { kind: 'now' }
  | { kind: 'project'; color: string; projectName: string };

export interface Over {
  label: string; // local hour of the over's first slot, e.g. "09"
  startMs: number; // epoch ms of the over's first slot; ball i covers startMs + i * 10 min
  balls: Ball[]; // always 6, one per 10 minutes
}

// The workday as "overs" of six 10-minute balls, from clock-in to the later of the leave time and now.
// A slot shows the project whose segments overlap it the longest; the slot holding `now` is `now`.
export function buildOvers(
  rec: WorkdayRecord,
  hours: number,
  tasks: BacklogTask[],
  projects: Project[],
  nowMs: number,
): Over[] {
  const startMs = Date.parse(rec.clockIn);
  const endMs = Math.max(startMs + hours * 3600_000, nowMs);
  const nowSlot = Math.floor((nowMs - startMs) / SLOT_MS);
  // nowSlot + 1 keeps the now ball when now sits exactly on a slot boundary at the end (e.g. 17:00).
  const slotCount = Math.max(1, Math.ceil((endMs - startMs) / SLOT_MS), nowSlot + 1);
  const overCount = Math.ceil(slotCount / BALLS_PER_OVER);

  // Only segments that overlap this workday's slots count, so old days' segments cost nothing in the slot loop.
  const windowEnd = startMs + slotCount * SLOT_MS;
  const spans: { projectId: string; from: number; to: number }[] = [];
  for (const t of tasks) {
    for (const s of t.segments ?? []) {
      const from = Date.parse(s.start);
      const to = s.end ? Date.parse(s.end) : nowMs;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
      if (to <= startMs || from >= windowEnd) continue;
      spans.push({ projectId: t.projectId, from, to });
    }
  }

  const slotBall = (slot: number): Ball => {
    if (slot === nowSlot) return { kind: 'now' };
    if (slot > nowSlot) return { kind: 'empty' };
    const slotStart = startMs + slot * SLOT_MS;
    const slotEnd = slotStart + SLOT_MS;
    const byProject = new Map<string, number>();
    for (const sp of spans) {
      const overlap = Math.min(sp.to, slotEnd) - Math.max(sp.from, slotStart);
      if (overlap > 0) byProject.set(sp.projectId, (byProject.get(sp.projectId) ?? 0) + overlap);
    }
    let bestId: string | null = null;
    let bestMs = 0;
    byProject.forEach((overlapMs, id) => {
      if (overlapMs > bestMs) {
        bestId = id;
        bestMs = overlapMs;
      }
    });
    if (bestId === null) return { kind: 'empty' };
    const project = projects.find((p) => p.id === bestId);
    return {
      kind: 'project',
      color: project?.color ?? UNASSIGNED_COLOR,
      projectName: project?.name ?? 'Unassigned',
    };
  };

  const overs: Over[] = [];
  for (let o = 0; o < overCount; o++) {
    const first = o * BALLS_PER_OVER;
    const overStart = startMs + first * SLOT_MS;
    const label = String(new Date(overStart).getHours()).padStart(2, '0');
    overs.push({ label, startMs: overStart, balls: Array.from({ length: BALLS_PER_OVER }, (_, i) => slotBall(first + i)) });
  }
  return overs;
}

/**
 * How busy each stretch of the day was: the axis runs from `fromMs` to `toMs` in `bucketMs` pieces and each
 * value is the share (0 to 1) of that piece the timers ran. Open segments end at `nowMs`. Used by the Time Card band.
 */
export function workBuckets(tasks: BacklogTask[], fromMs: number, toMs: number, nowMs: number, bucketMs = 15 * 60_000): number[] {
  const n = Math.max(1, Math.ceil((toMs - fromMs) / bucketMs));
  const sums = new Array<number>(n).fill(0);
  for (const t of tasks) {
    for (const seg of t.segments ?? []) {
      const a = Math.max(Date.parse(seg.start), fromMs);
      const b = Math.min(seg.end ? Date.parse(seg.end) : nowMs, toMs);
      if (!(b > a)) continue;
      for (let i = Math.floor((a - fromMs) / bucketMs); i < n; i++) {
        const lo = fromMs + i * bucketMs;
        if (lo >= b) break;
        sums[i] += Math.min(b, lo + bucketMs) - Math.max(a, lo);
      }
    }
  }
  return sums.map((v) => Math.min(1, v / bucketMs));
}
