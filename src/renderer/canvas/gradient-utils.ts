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

/** Minimal canvas context subset needed for gradient creation. */
export interface GradientContext {
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
}

/** Gradient lookup and storage; the caller owns the cache capacity policy. */
export interface GradientCache {
  get(key: string): CanvasGradient | undefined;
  set(key: string, gradient: CanvasGradient): void;
}

/**
 * Get or create a cached linear gradient (top-to-bottom) with alpha stops.
 *
 * Both CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D
 * satisfy the GradientContext interface.
 */
export function getCachedGradient(
  ctx: GradientContext,
  cache: GradientCache,
  baseColor: string,
  h: number,
  topAlpha: number,
  scAlpha: number,
  bottomAlpha: number
): CanvasGradient {
  const key = `${baseColor}|${h}|${topAlpha}|${scAlpha}|${bottomAlpha}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, toRgba(baseColor, topAlpha));
  grad.addColorStop(0.48, toRgba(baseColor, scAlpha));
  grad.addColorStop(1, toRgba(baseColor, bottomAlpha));
  cache.set(key, grad);
  return grad;
}
