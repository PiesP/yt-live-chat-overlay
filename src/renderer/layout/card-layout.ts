// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { rendererLayout, spacing } from '@util/design-tokens';

export interface CardInsets {
  horizontal: number;
  vertical: number;
}

/** Resolve compact font-relative insets that also contain the text outline. */
export function getRegularCardInsets(fontSize: number, outlineWidthPx = 0): CardInsets {
  const safeFontSize = Number.isFinite(fontSize) ? Math.max(1, fontSize) : 1;
  const safeOutline = Number.isFinite(outlineWidthPx) ? Math.max(0, outlineWidthPx) : 0;
  const outlineSafety = Math.ceil(safeOutline / 2) + (safeOutline > 0 ? 1 : 0);
  return {
    horizontal: Math.max(
      rendererLayout.regularCard.paddingXMin,
      Math.min(
        rendererLayout.regularCard.paddingXMax,
        Math.round(safeFontSize * rendererLayout.regularCard.paddingXScale)
      ),
      outlineSafety
    ),
    vertical: Math.max(
      rendererLayout.regularCard.paddingYMin,
      Math.min(
        rendererLayout.regularCard.paddingYMax,
        Math.round(safeFontSize * rendererLayout.regularCard.paddingYScale)
      ),
      outlineSafety
    ),
  };
}

/** Width reserved for an author photo and its following name gap. */
export function getAuthorPhotoSlotWidth(authorPhotoUrl?: string): number {
  return authorPhotoUrl ? rendererLayout.authorPhotoSize + spacing.xs : 0;
}

/** Height of the author row, based only on information that is displayed. */
export function getAuthorRowHeight(nameHeight: number, authorPhotoUrl?: string): number {
  return Math.max(nameHeight, authorPhotoUrl ? rendererLayout.authorPhotoSize : 0);
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
