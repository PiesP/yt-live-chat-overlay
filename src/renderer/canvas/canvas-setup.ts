// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Canvas setup utilities extracted from CanvasRenderer.
 *
 * Standalone functions for canvas/DPR management and offscreen detection.
 * These manage the canvas element's dimensions, device-pixel-ratio transform,
 * and the IntersectionObserver + recovery poll for offscreen detection — they
 * are not rendering logic.
 */

import type { OverlayDimensions } from '@app-types';

/**
 * Apply device pixel ratio to canvas dimensions and context transform.
 * Called on initial setup and on dimension changes.
 * Returns the current devicePixelRatio for updating `lastDpr`.
 */
export function applyDevicePixelRatio(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  dims: OverlayDimensions
): number {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = dims.width * dpr;
  canvas.height = dims.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return dpr;
}

/**
 * Update canvas dimensions when device pixel ratio changes.
 * No-op when `dpr === lastDpr`.
 * Returns the new DPR value (same as before if unchanged).
 */
export function updateCanvasDpr(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  dims: OverlayDimensions,
  lastDpr: number
): number {
  const dpr = window.devicePixelRatio || 1;
  if (dpr === lastDpr) return lastDpr;
  canvas.width = dims.width * dpr;
  canvas.height = dims.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return dpr;
}

/**
 * Set up an IntersectionObserver on the canvas to detect when it is
 * hidden (e.g. behind a settings modal/backdrop). On offscreen transition
 * the renderer is paused; a recovery poll guards against missed
 * intersection-entries when the modal is dismissed.
 *
 * @param canvas        - The canvas element to observe.
 * @param onOffscreen   - Called when the canvas leaves the viewport.
 * @param onVisible     - Called when the canvas re-enters the viewport.
 * @returns The IntersectionObserver instance (for cleanup).
 */
export function setupOffscreenObserver(
  canvas: HTMLCanvasElement,
  onOffscreen: () => void,
  onVisible: () => void
): IntersectionObserver {
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (!entry.isIntersecting) {
        onOffscreen();
      } else {
        onVisible();
      }
    },
    { threshold: 0 }
  );
  observer.observe(canvas);
  return observer;
}

/**
 * Disconnect and clean up an IntersectionObserver.
 */
export function disconnectObserver(observer: IntersectionObserver | null): void {
  if (observer) {
    observer.disconnect();
  }
}

/**
 * Periodic poll (~1000ms) that checks whether the canvas has become
 * visible again. Guards against the IntersectionObserver failing to
 * fire a re-entry event when a modal/backdrop covering the canvas is
 * dismissed.
 *
 * @param canvas    - The canvas element to check visibility of.
 * @param onVisible - Called when the canvas is detected as visible.
 * @returns A function to stop the poll (calling it clears the interval).
 */
export function startOffscreenPoll(canvas: HTMLCanvasElement, onVisible: () => void): () => void {
  const intervalId = setInterval(() => {
    // Check multiple visibility signals to handle edge cases
    const rect = canvas.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const isRectVisible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < viewportW &&
      rect.top < viewportH &&
      rect.right > 0 &&
      rect.bottom > 0;
    const docVisible = document.visibilityState === 'visible';

    // Canvas is considered visible when the rect intersects the viewport
    // AND the document is visible (tab not hidden).
    if (isRectVisible && docVisible) {
      clearInterval(intervalId);
      onVisible();
    }
  }, 1000);

  return () => {
    clearInterval(intervalId);
  };
}
