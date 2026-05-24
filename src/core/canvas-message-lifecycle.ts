/**
 * CanvasMessage lifecycle management for the Canvas2D renderer.
 *
 * Extracted from renderer-canvas.ts to separate message state management
 * from the render loop and queue draining logic.
 */

import type { ChatMessage } from '@app-types';
import { rendererLayout } from '@core/design-tokens';

export interface CanvasMessage {
  message: ChatMessage;
  startTime: number;
  duration: number;
  width: number;
  height: number;
  startX: number;
  x: number;
  y: number;
  pausedDuration: number;
  laneIndex: number;
  /** Time stagger delay (ms) applied to this message's start. */
  staggerDelay: number;
}

interface CreateCanvasMessageParams {
  message: ChatMessage;
  now: number;
  msgWidth: number;
  msgHeight: number;
  laneY: number;
  duration?: number | undefined;
  startX?: number | undefined;
  laneIndex?: number | undefined;
  staggerDelay?: number | undefined;
}

export function createCanvasMessage(params: CreateCanvasMessageParams): CanvasMessage {
  const { message, now, msgWidth, msgHeight, laneY, staggerDelay = 0 } = params;
  const duration = params.duration ?? rendererLayout.topBottomDurationMs;
  const startX = params.startX ?? 0;
  return {
    message,
    startTime: now + staggerDelay,
    duration,
    width: msgWidth,
    height: msgHeight,
    startX,
    x: startX,
    y: laneY,
    pausedDuration: 0,
    laneIndex: params.laneIndex ?? 0,
    staggerDelay,
  };
}

/**
 * Remove expired messages in-place. Returns the new logical length.
 * Messages whose elapsed time exceeds duration are compacted out.
 */
export function cleanupExpiredMessages(messages: CanvasMessage[], now: number): number {
  const oldLength = messages.length;
  let writeIdx = 0;
  for (let i = 0; i < oldLength; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const elapsed = now - msg.startTime - msg.pausedDuration;
    if (elapsed < msg.duration) {
      messages[writeIdx] = msg;
      writeIdx++;
    }
  }
  return writeIdx;
}

/** Accumulate paused duration across all active messages. */
export function applyPausedDurationToMessages(messages: CanvasMessage[], pausedMs: number): void {
  for (const msg of messages) {
    msg.pausedDuration += pausedMs;
  }
}
