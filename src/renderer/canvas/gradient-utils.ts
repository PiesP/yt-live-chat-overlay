// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared canvas gradient utilities for card rendering.
 *
 * Used by both main-thread (CanvasRenderingContext2D) and worker
 * (OffscreenCanvasRenderingContext2D) renderers to create cached
 * linear gradients with alpha stops for paid card backgrounds.
 */

import { toRgba } from '@renderer/color-utils';
import { GRADIENT_CACHE_MAX } from '@renderer/constants';

/** Minimal canvas context subset needed for gradient creation. */
export interface GradientContext {
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
}

/**
 * Get or create a cached linear gradient (top-to-bottom) with alpha stops.
 *
 * Uses LRU eviction when the cache exceeds GRADIENT_CACHE_MAX entries.
 * Both CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D
 * satisfy the GradientContext interface.
 */
export function getCachedGradient(
  ctx: GradientContext,
  cache: Map<string, CanvasGradient>,
  baseColor: string,
  h: number,
  topAlpha: number,
  scAlpha: number,
  bottomAlpha: number
): CanvasGradient {
  const key = `${baseColor}|${h}|${topAlpha}|${scAlpha}|${bottomAlpha}`;
  const cached = cache.get(key);
  if (cached) return cached;
  // LRU eviction on overflow
  if (cache.size >= GRADIENT_CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, toRgba(baseColor, topAlpha));
  grad.addColorStop(0.48, toRgba(baseColor, scAlpha));
  grad.addColorStop(1, toRgba(baseColor, bottomAlpha));
  cache.set(key, grad);
  return grad;
}
