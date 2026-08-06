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
