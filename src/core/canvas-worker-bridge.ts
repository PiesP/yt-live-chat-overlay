// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Worker bridge utilities for canvas rendering.
 *
 * Handles image readiness checks and other bridge logic between the
 * CanvasRenderer and the OffscreenCanvas Web Worker.
 */

/** Check if an image element is fully loaded and has valid dimensions. */
export function isImageReady(img: unknown): boolean {
  return (img as HTMLImageElement)?.complete === true && (img as HTMLImageElement).naturalWidth > 0;
}
