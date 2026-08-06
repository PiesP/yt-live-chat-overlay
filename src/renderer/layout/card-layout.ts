// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { rendererLayout, spacing } from '@util/design-tokens';

export interface CardInsets {
  horizontal: number;
  vertical: number;
}

/** Resolve compact font-relative insets that also contain the text outline. */
export function getRegularCardInsets(
  fontSize: number,
  outlineWidthPx = 0,
  hasAuthorPhoto = false
): CardInsets {
  const safeFontSize = Number.isFinite(fontSize) ? Math.max(1, fontSize) : 1;
  const safeOutline = Number.isFinite(outlineWidthPx) ? Math.max(0, outlineWidthPx) : 0;
  const outlineSafety = Math.ceil(safeOutline / 2) + (safeOutline > 0 ? 1 : 0);
  const photoSafety = hasAuthorPhoto ? rendererLayout.authorPhotoShadowOutset : 0;
  return {
    horizontal: Math.max(
      rendererLayout.regularCard.paddingXMin,
      Math.min(
        rendererLayout.regularCard.paddingXMax,
        Math.round(safeFontSize * rendererLayout.regularCard.paddingXScale)
      ),
      outlineSafety,
      photoSafety
    ),
    vertical: Math.max(
      rendererLayout.regularCard.paddingYMin,
      Math.min(
        rendererLayout.regularCard.paddingYMax,
        Math.round(safeFontSize * rendererLayout.regularCard.paddingYScale)
      ),
      outlineSafety,
      photoSafety
    ),
  };
}

/** Width reserved for an author photo and its following name gap. */
export function getAuthorPhotoSlotWidth(authorPhotoUrl?: string): number {
  return authorPhotoUrl
    ? rendererLayout.authorPhotoSize + rendererLayout.authorPhotoShadowOutset + spacing.xs
    : 0;
}

/** Height of the author row, based only on information that is displayed. */
export function getAuthorRowHeight(nameHeight: number, authorPhotoUrl?: string): number {
  return Math.max(
    nameHeight,
    authorPhotoUrl ? rendererLayout.authorPhotoSize + rendererLayout.authorPhotoShadowOutset : 0
  );
}

export interface PaidCardWidthBounds {
  min: number;
  max: number;
}

/** Resolve content-proportional and viewport-safe paid-card width bounds. */
export function getPaidCardWidthBounds(
  fontSize: number,
  availableWidth?: number
): PaidCardWidthBounds {
  const designMax = rendererLayout.superchatMaxWidth;
  const finiteAvailable =
    availableWidth !== undefined && Number.isFinite(availableWidth)
      ? Math.max(1, Math.floor(availableWidth))
      : designMax;
  const max = Math.min(designMax, finiteAvailable);
  const proportionalMin = Math.round(fontSize * rendererLayout.paidCardMinWidthScale);
  const designMin = Math.max(
    rendererLayout.paidCardMinWidthFloor,
    Math.min(rendererLayout.superchatMinWidth, proportionalMin)
  );
  return { min: Math.min(designMin, max), max };
}

/** Clamp an author name to the remaining inner width after its stable photo slot. */
export function getAuthorNameMaxWidth(
  innerWidth: number,
  configuredMaxWidth: number,
  authorPhotoUrl?: string
): number {
  return Math.max(
    1,
    Math.min(configuredMaxWidth, Math.max(1, innerWidth - getAuthorPhotoSlotWidth(authorPhotoUrl)))
  );
}
