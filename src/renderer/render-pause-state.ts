// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';

/** One freeze interval shared by visibility, video and explicit user pauses. */
export class RenderPauseState {
  isPaused = false;
  isVideoPaused = false;
  isUserPaused = false;
  pausedAt: number | null = null;
  private includesUserPause = false;
  private readonly videoBuffer: ChatMessage[] = [];
  private static readonly VIDEO_BUFFER_MAX = 200;

  setUserPaused(paused: boolean): boolean {
    if (this.isUserPaused === paused) return false;
    if (paused) {
      this.includesUserPause = true;
      this.begin();
    }
    this.isUserPaused = paused;
    return true;
  }

  beginVisibilityPause(): boolean {
    if (this.isPaused) return false;
    this.begin();
    this.isPaused = true;
    return true;
  }

  endVisibilityPause(): boolean {
    if (!this.isPaused) return false;
    this.isPaused = false;
    return true;
  }

  beginVideoPause(): boolean {
    if (this.isVideoPaused) return false;
    this.isVideoPaused = true;
    return true;
  }

  endVideoPause(): boolean {
    if (!this.isVideoPaused) return false;
    this.isVideoPaused = false;
    return true;
  }

  /** A paused video rejects admission but retains a bounded replay buffer. */
  bufferIfVideoPaused(message: ChatMessage): boolean {
    if (!this.isVideoPaused) return false;
    if (this.videoBuffer.length < RenderPauseState.VIDEO_BUFFER_MAX) {
      this.videoBuffer.push(message);
    }
    return true;
  }

  takeVideoBuffer(): ChatMessage[] {
    return this.videoBuffer.splice(0);
  }

  finish(maxMessageAgeMs: number): { durationMs: number; preserveElapsed: boolean } | null {
    if (this.pausedAt === null) return null;
    const raw = Math.max(0, performance.now() - this.pausedAt);
    const preserveElapsed = this.includesUserPause;
    const durationMs = preserveElapsed ? raw : Math.min(raw, maxMessageAgeMs * 2);
    this.pausedAt = null;
    this.includesUserPause = false;
    return { durationMs, preserveElapsed };
  }

  clearElapsed(): void {
    if (!this.includesUserPause) this.pausedAt = null;
  }

  destroy(): void {
    this.isPaused = false;
    this.isVideoPaused = false;
    this.isUserPaused = false;
    this.pausedAt = null;
    this.includesUserPause = false;
    this.videoBuffer.length = 0;
  }

  private begin(): void {
    this.pausedAt ??= performance.now();
  }
}
