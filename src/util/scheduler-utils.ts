// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Scheduler utilities wrapping scheduler.yield() and scheduler.postTask()
 * with Safari fallbacks.
 *
 * Based on GoogleChrome/modern-web-guidance:
 * - https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/performance/break-up-long-tasks.md
 * - https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/performance/schedule-tasks-by-priority.md
 *
 * scheduler.yield():
 *   Chrome 129+, Edge 129+, Firefox 142+, Safari — not supported.
 *   Falls back to setTimeout(0) Promise.
 *
 * scheduler.postTask():
 *   Chrome 129+, Edge 129+, Firefox 142+, Safari — not supported.
 *   Falls back to setTimeout(0) or Promise microtask.
 */

/** Default budget per yield slice (50ms = long task boundary per RAIL). */
const YIELD_BUDGET_MS = 50;

// ── Feature detection (computed once at module load) ──────────────────────

const hasSchedulerYield: boolean =
  typeof globalThis !== 'undefined' &&
  globalThis.scheduler !== undefined &&
  typeof (globalThis.scheduler as { yield?: unknown }).yield === 'function';

const hasPostTask: boolean =
  typeof globalThis !== 'undefined' &&
  globalThis.scheduler !== undefined &&
  typeof (globalThis.scheduler as { postTask?: unknown }).postTask === 'function';

// ── scheduler.yield() wrapper ────────────────────────────────────────────

/**
 * Yield control back to the browser's main thread so it can process pending
 * user input, rendering, or other high-priority work.
 *
 * Uses the native scheduler.yield() when available (more efficient — avoids
 * the ~4ms minimum setTimeout delay), otherwise falls back to
 * new Promise(resolve => setTimeout(resolve, 0)).
 */
async function schedulerYield(): Promise<void> {
  if (hasSchedulerYield) {
    await (globalThis.scheduler as unknown as { yield(): Promise<void> }).yield();
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// ── scheduler.postTask() wrapper ─────────────────────────────────────────

/** Priority levels matching the Prioritized Task Scheduling API. */
export type OverlayTaskPriority = 'user-blocking' | 'user-visible' | 'background';

/**
 * Schedule a callback to run with the specified priority.
 *
 * Priority semantics:
 *   'user-blocking' — Frame-critical work that must complete before the next
 *                     paint (e.g. lane allocation, placement commits).
 *   'user-visible'  — Work that affects the display but can tolerate a frame
 *                     of delay (e.g. message processing, translation).
 *   'background'    — Non-time-critical maintenance (e.g. queue trimming,
 *                     stats collection, expired cache cleanup).
 *
 * Falls back to setTimeout(0) when scheduler.postTask() is unavailable
 * (Safari, older browsers).  For 'background' priority in the fallback path,
 * uses a slightly longer delay to avoid interfering with more urgent work.
 */
export function scheduleOverlayTask<T>(
  fn: () => T,
  options?: { priority?: OverlayTaskPriority }
): Promise<T> {
  if (hasPostTask) {
    try {
      return (
        globalThis.scheduler as unknown as {
          postTask<T>(fn: () => T, options?: { priority?: string }): Promise<T>;
        }
      ).postTask(fn, { priority: options?.priority ?? 'user-visible' });
    } catch {
      // Fall through on error (e.g. detached document)
    }
  }

  // Safari / fallback path
  const priority = options?.priority ?? 'user-visible';
  return new Promise<T>((resolve) => {
    switch (priority) {
      case 'background':
        // Defer more aggressively so urgent work runs first.
        // Using setTimeout(4) adds ~4ms of slack to let higher-priority tasks
        // scheduled via setTimeout(0) execute first.
        setTimeout(() => resolve(fn()), 4);
        break;
      case 'user-blocking':
        // Use a microtask-style schedule: requestAnimationFrame would align
        // with the next frame boundary which defeats the purpose of being
        // 'user-blocking'.  setTimeout(0) runs after the current macrotask
        // but before the next rendering frame in most browsers.
        //
        // For truly blocking work, a MessageChannel-based scheduler would be
        // faster, but setTimeout(0) is universally supported and the
        // performance difference is negligible for our use case.
        setTimeout(() => resolve(fn()), 0);
        break;
      default:
        // Default priority; runs promptly but allows user-blocking work to
        // be queued first when both are pending in the same macrotask.
        setTimeout(() => resolve(fn()), 0);
        break;
    }
  });
}

// ── Deadline-based yielding (budget management) ──────────────────────────

/**
 * Check whether the current work slice has exceeded the time budget and yield
 * if needed.
 *
 * Typical usage in an async processing loop:
 *
 *   let deadline = performance.now() + YIELD_BUDGET_MS;
 *   for (const item of items) {
 *     process(item);
 *     deadline = await yieldAtDeadline(deadline);
 *   }
 *
 * @param deadline  The performance.now() threshold at which to yield.
 * @param budgetMs  Budget per slice (default 50ms, the long task boundary).
 * @returns A new deadline if yielded, or the original deadline unchanged.
 */
export async function yieldAtDeadline(
  deadline: number,
  budgetMs = YIELD_BUDGET_MS
): Promise<number> {
  if (performance.now() >= deadline) {
    await schedulerYield();
    return performance.now() + budgetMs;
  }
  return deadline;
}
