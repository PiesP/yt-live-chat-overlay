// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export interface DrainPlacementResult {
  placed: boolean;
  oversized: boolean;
  /** Cumulative temporal stagger assigned to this committed message. */
  staggerDelayMs?: number;
}

export interface DrainBatch<T> {
  readonly candidates: readonly T[];
  readonly committed: T[];
  readonly unplaceable: T[];
  batchIndex: number;
  staggerCursorMs: number;
}

interface DrainQueue<T> {
  removeAll(messages: T[]): number;
}

/** Both renderers count failed collision attempts against the same work limit. */
export const DRAIN_MAX_ATTEMPTS = 32;
export const DRAIN_WORK_BUDGET_MS = 4;
/** Two higher-priority successes retain paid preference before one priority-zero opportunity. */
export const HIGH_PRIORITY_SUCCESS_SHARE = 2;

/** Backlog priority -50 is deliberately outside the ordinary service share. */
export function fairDrainStartPriority(
  eligiblePriorities: readonly number[],
  higherPrioritySuccesses: number,
  interruptedPriority?: number
): number | undefined {
  // A saved time-budget continuation must run first. Otherwise a repeatedly
  // costly ordinary failure can suppress every higher-priority attempt.
  if (interruptedPriority !== undefined && eligiblePriorities.includes(interruptedPriority)) {
    return interruptedPriority;
  }
  return higherPrioritySuccesses >= HIGH_PRIORITY_SUCCESS_SHARE &&
    eligiblePriorities.includes(0) &&
    eligiblePriorities.some((priority) => priority > 0)
    ? 0
    : undefined;
}

/** Count committed admissions, never failed attempts or merely queued messages. */
export function nextHigherPrioritySuccesses(previous: number, priority: number): number {
  if (priority === 0) return 0;
  return priority > 0 ? Math.min(HIGH_PRIORITY_SUCCESS_SHARE, previous + 1) : previous;
}

/**
 * Preserve priority order while rotating past a repeatedly unplaceable prefix.
 * Reserve one attempt for each lower priority group; those attempts happen only
 * after the higher group's share. The cursor contains queue identities, not a
 * second copy of pending work, and is bounded by the existing priority buckets.
 */
export function selectDrainCandidates<T>(
  snapshot: readonly T[],
  priorityOf: (message: T) => number,
  cursors: ReadonlyMap<number, T>,
  limit = DRAIN_MAX_ATTEMPTS,
  resumePriority?: number
): T[] {
  const groups = new Map<number, T[]>();
  for (const message of snapshot) {
    const priority = priorityOf(message);
    const group = groups.get(priority);
    if (group) group.push(message);
    else groups.set(priority, [message]);
  }
  const priorities = [...groups.keys()].sort((a, b) => b - a);
  // A time-budget interruption resumes the next group once. Otherwise a
  // costly, failing high-priority prefix could consume every frame forever.
  const resumeIndex = resumePriority === undefined ? -1 : priorities.indexOf(resumePriority);
  if (resumeIndex > 0) priorities.push(...priorities.splice(0, resumeIndex));
  const result: T[] = [];
  for (let index = 0; index < priorities.length; index++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is bounded by priorities.length.
    const priority = priorities[index]!;
    // oxlint-disable-next-line typescript/no-non-null-assertion -- each priority comes from groups.keys(); groups is not mutated.
    const group = groups.get(priority)!;
    const cursor = cursors.get(priority);
    const start = cursor === undefined ? 0 : (group.indexOf(cursor) + 1) % group.length;
    const quota = Math.min(
      group.length,
      Math.max(0, limit - result.length - (priorities.length - index - 1))
    );
    for (let offset = 0; offset < quota; offset++) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- group is nonempty and modulo selects a valid index.
      result.push(group[(start + offset) % group.length]!);
    }
  }
  return result;
}

export function nextDrainPriority<T>(
  candidates: readonly T[],
  priorityOf: (message: T) => number,
  lastPriority: number
): number | undefined {
  const priorities = [...new Set(candidates.map(priorityOf))];
  if (priorities.length < 2) return undefined;
  const index = priorities.indexOf(lastPriority);
  return priorities[(index + 1) % priorities.length];
}

export function createDrainBatch<T>(candidates: readonly T[]): DrainBatch<T> {
  return { candidates, committed: [], unplaceable: [], batchIndex: 0, staggerCursorMs: 0 };
}

/** Record one placement result and return whether the message was committed. */
export function recordDrainResult<T>(
  batch: DrainBatch<T>,
  message: T,
  result: DrainPlacementResult
): boolean {
  if (result.oversized) batch.unplaceable.push(message);
  if (!result.placed) return false;
  if (result.staggerDelayMs !== undefined && Number.isFinite(result.staggerDelayMs)) {
    batch.staggerCursorMs = Math.max(batch.staggerCursorMs, result.staggerDelayMs);
  }
  batch.batchIndex++;
  batch.committed.push(message);
  return true;
}

/** Apply peek-commit removals while retaining transient placement failures. */
export function commitDrainBatch<T>(queue: DrainQueue<T>, batch: DrainBatch<T>): void {
  if (batch.committed.length > 0) queue.removeAll(batch.committed);
  if (batch.unplaceable.length > 0) queue.removeAll(batch.unplaceable);
}
