// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** A drawable frame must have a positive quantized body alpha and intersect the viewport. */
export function isPresentableFrame(
  elapsed: number,
  duration: number,
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  opacityBucket: number,
  hidden: boolean
): boolean {
  return (
    !hidden &&
    opacityBucket > 0 &&
    viewportWidth > 0 &&
    viewportHeight > 0 &&
    width > 0 &&
    height > 0 &&
    elapsed >= 0 &&
    elapsed < duration &&
    x < viewportWidth &&
    x + width > 0 &&
    y < viewportHeight &&
    y + height > 0
  );
}

/** The accessible body follows the original and translation actually selected for display. */
export function accessiblePresentationText(
  canonical: string,
  translated: string | null | undefined,
  enabled: boolean,
  mode: 'dual' | 'replace'
): string {
  if (!enabled || !translated) return canonical;
  if (mode === 'replace') return translated;
  return translated === canonical ? canonical : `${canonical} — ${translated}`;
}
