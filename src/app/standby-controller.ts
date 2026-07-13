// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * StandbyController — manages pre-live waiting mode.
 *
 * Extracted from RuntimeManager. When a YouTube stream hasn't started yet,
 * the controller enters standby mode: polls for stream availability with
 * exponential backoff (5s → 10s → 20s → 40s → 60s), sets the renderer's
 * standby status for UI feedback, and triggers a session restart when the
 * stream is detected.
 */

import { bootstrapChatSession } from '@chat/youtube/api';
import type { RendererBase } from '@renderer/renderer-base';
import { clearSafeTimeout, isAbortError } from '@util/dom';
import { createLogger } from '@util/logging';

const log = createLogger('Standby');

type RestartReason = 'foreground-return' | 'watchdog' | 'standby-resolved';

const RECHECK_INTERVAL_MS = 5_000;
const RETRY_DELAY_MS = 3_000;
const RECHECK_MAX_MS = 60_000;
const RECHECK_FACTOR = 2;

export class StandbyController {
  private mode = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDelay = RECHECK_INTERVAL_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private renderer: RendererBase | null = null;
  /** Generation counter to guard against stale poll callbacks after exit(). */
  private pollGeneration = 0;

  constructor(
    private readonly getAbortSignal: () => AbortSignal,
    private readonly isDisposed: () => boolean,
    private readonly onStreamDetected: (reason: RestartReason) => void
  ) {}

  /** Attach the renderer for standby status UI feedback. */
  setRenderer(renderer: RendererBase | null): void {
    this.renderer = renderer;
  }

  /** Enter standby mode — begin polling for stream availability. */
  enter(): void {
    this.mode = true;
    this.renderer?.setStandbyStatus(true);

    this.pollDelay = RECHECK_INTERVAL_MS;
    this.schedulePoll();
  }

  /** Exit standby mode — stop polling and clear timers.
   *  Safe to call multiple times; subsequent calls are no-ops.
   *  Called by destroy() and by RuntimeManager during session teardown. */
  exit(): void {
    if (!this.mode) return; // already exited — idempotent
    this.mode = false;
    this.pollGeneration++;
    this.stopPolling();
    this.retryTimer = clearSafeTimeout(this.retryTimer);
    this.renderer?.setStandbyStatus(false);
  }

  /** Whether currently in standby mode. */
  isStandby(): boolean {
    return this.mode;
  }

  /** Clean up all timers. */
  destroy(): void {
    this.exit();
  }

  // ── Polling ──────────────────────────────────────────────────────────

  private stopPolling(): void {
    this.pollTimer = clearSafeTimeout(this.pollTimer);
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, this.pollDelay);
  }

  private async poll(): Promise<void> {
    if (this.isDisposed() || !this.mode) return;

    // Bail early if exit() was called while we were awaiting a previous tick
    // (e.g., during sleep between scheduled polls).
    const gen = this.pollGeneration;

    try {
      const result = await bootstrapChatSession(this.getAbortSignal());
      if (gen !== this.pollGeneration) return; // stale — exit() was called during fetch

      if (result.status === 'ready') {
        log.info('app.standby.stream-detected');
        this.stopPolling();
        this.onStreamDetected('standby-resolved');
        return;
      }

      // Stream not yet live — increase backoff for next poll.
      this.pollDelay = Math.min(this.pollDelay * RECHECK_FACTOR, RECHECK_MAX_MS);

      if (result.status === 'retryable') {
        this.scheduleRetry();
        return;
      }

      this.schedulePoll();
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        log.warn('app.standby.poll-failed', { error: String(error) });
        this.scheduleRetry();
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.poll();
    }, RETRY_DELAY_MS);
  }
}
