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
  private paused = false;
  private pollController: AbortController | null = null;
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
    this.paused = false;
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
    this.paused = false;
    this.pollGeneration++;
    this.abortPoll();
    this.stopPolling();
    this.retryTimer = clearSafeTimeout(this.retryTimer);
    this.renderer?.setStandbyStatus(false);
  }

  /** Whether currently in standby mode. */
  isStandby(): boolean {
    return this.mode;
  }

  /** Suspend timers and cancel an in-flight availability check while hidden. */
  pause(): void {
    if (!this.mode || this.paused) return;
    this.paused = true;
    this.pollGeneration++;
    this.abortPoll();
    this.stopPolling();
    this.retryTimer = clearSafeTimeout(this.retryTimer);
  }

  /** Resume standby with an immediate availability check on foreground return. */
  resume(): void {
    if (!this.mode || !this.paused) return;
    this.paused = false;
    if (this.isDisposed()) return;
    void this.poll();
  }

  /** Clean up all timers. */
  destroy(): void {
    this.exit();
  }

  // ── Polling ──────────────────────────────────────────────────────────

  private stopPolling(): void {
    this.pollTimer = clearSafeTimeout(this.pollTimer);
  }

  private abortPoll(): void {
    this.pollController?.abort();
    this.pollController = null;
  }

  private schedulePoll(): void {
    if (!this.mode || this.paused || this.isDisposed()) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, this.pollDelay);
  }

  private async poll(): Promise<void> {
    if (this.isDisposed() || !this.mode || this.paused) return;

    // Bail early if exit() was called while we were awaiting a previous tick
    // (e.g., during sleep between scheduled polls).
    const gen = this.pollGeneration;
    const controller = new AbortController();
    this.pollController = controller;
    const sessionSignal = this.getAbortSignal();
    const signal = AbortSignal.any([sessionSignal, controller.signal]);

    try {
      const result = await bootstrapChatSession(signal);
      if (gen !== this.pollGeneration || this.paused || !this.mode || this.isDisposed()) return;

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
    } finally {
      if (this.pollController === controller) this.pollController = null;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    // Guard: don't schedule a retry if we've already exited standby mode.
    // exit() clears timers synchronously but a concurrent poll() error handler
    // may still call scheduleRetry() before the mode check on the next poll
    // iteration. This idempotent gate prevents stray retry timers after exit.
    if (!this.mode || this.paused || this.isDisposed()) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.poll();
    }, RETRY_DELAY_MS);
  }
}
