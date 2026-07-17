// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Viewport-responsive font scaling utilities.
 *
 * Scales fontSize linearly with viewport height, clamped to a configurable
 * range, so text remains readable regardless of player size.
 */

export interface FontScalingConfig {
  /** Base font size in logical pixels (from settings). */
  fontSize: number;
  /** Reference viewport height for the base fontSize (px). */
  fontBaseViewportHeight: number;
  /** Minimum fontSize regardless of viewport. */
  fontMinSize: number;
  /** Maximum fontSize regardless of viewport. */
  fontMaxSize: number;
}

/**
 * Compute the effective font size based on viewport height.
 *
 * Linear scaling: effective = fontSize × (viewportHeight / baseViewportHeight),
 * clamped to [fontMinSize, fontMaxSize].
 */
export function computeEffectiveFontSize(
  config: FontScalingConfig,
  viewportHeight: number
): number {
  if (viewportHeight <= 0) return config.fontSize;
  const scaled = Math.round(config.fontSize * (viewportHeight / config.fontBaseViewportHeight));
  return Math.max(config.fontMinSize, Math.min(config.fontMaxSize, scaled));
}
