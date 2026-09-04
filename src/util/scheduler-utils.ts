// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Scheduler utility wrapping scheduler.postTask() with Safari fallbacks.
 *
 * Based on GoogleChrome/modern-web-guidance:
 * - https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/performance/schedule-tasks-by-priority.md
 *
 * scheduler.postTask():
 *   Chrome 129+, Edge 129+, Firefox 142+, Safari — not supported.
 *   Falls back to setTimeout(0) or Promise microtask.
 */

// ── Feature detection (computed once at module load) ──────────────────────

const hasPostTask: boolean =
  typeof globalThis !== 'undefined' &&
  globalThis.scheduler !== undefined &&
  typeof (globalThis.scheduler as { postTask?: unknown }).postTask === 'function';

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
  return new Promise<T>((resolve, reject) => {
    // Background work gets extra slack; visible and blocking work run in the
    // next macrotask. The wrapper converts synchronous callback failures into
    // promise rejections and also assimilates promise-returning callbacks.
    const delay = priority === 'background' ? 4 : 0;
    setTimeout(() => {
      try {
        resolve(fn());
      } catch (error) {
        reject(error);
      }
    }, delay);
  });
}
