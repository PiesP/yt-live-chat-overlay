// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { FontWeight } from '@app-types';
import type { TextDirection } from '@renderer/canvas/bidi-layout';
import {
  type PreparedWrappedContent,
  prepareWrappedContent,
  type SharedContentSegment,
} from '@renderer/canvas/shared';
import { TRANSLATION_FONT_SCALE, TRANSLATION_GAP_PX } from '@renderer/constants';
import { getAuthorPhotoSlotWidth, getAuthorRowHeight } from '@renderer/layout/card-layout';
import {
  getFontString,
  getTextMeasurementGeneration,
  measureTextHeight,
} from '@renderer/text-measure';
import { DEFAULT_FONT_FAMILY, rendererLayout, spacing } from '@util/design-tokens';

// A document or Worker can register a new face after the first draw without changing
// the CSS family string or the renderer's settings generation. Keep those draws live.
function canRetainPaidFont(fontFamily: string): boolean {
  const faces =
    typeof document === 'undefined'
      ? (globalThis as { fonts?: FontFaceSet }).fonts
      : document.fonts;
  if (!faces?.size) return true;
  if (fontFamily !== DEFAULT_FONT_FAMILY) return false;
  // The default begins with system-ui. Only its named -apple-system fallback
  // could resolve to a registered face. An escaped CSS spelling is ambiguous.
  for (const face of faces) {
    const family = face.family.trim().toLowerCase();
    if (family.includes('\\') || family.replace(/^["']|["']$/g, '') === '-apple-system') {
      return false;
    }
  }
  return true;
}

export interface PaidCardPlanInput {
  activeCard?: object | undefined;
  kind: 'superchat' | 'membership';
  width: number;
  fontSize: number;
  fontWeight: FontWeight;
  fontFamily: string;
  paddingH: number;
  paddingV: number;
  author?: string | undefined;
  authorPhotoUrl?: string | undefined;
  showAuthor: boolean;
  amount?: string | undefined;
  showAmount: boolean;
  membershipHeader?: string | undefined;
  content: readonly SharedContentSegment[];
  translatedText?: string | null | undefined;
  maxBodyLines: number;
  outlineWidthPx: number;
  wide: boolean;
  sticker: boolean;
  measure: (text: string, font: string, direction?: TextDirection) => number;
  measureHeight?: (font: string, fontSize: number) => number;
  context?: Parameters<typeof prepareWrappedContent>[6] | undefined;
}

export interface PaidCardPlan {
  width: number;
  height: number;
  innerWidth: number;
  authorY?: number;
  authorMaxWidth: number;
  amountX?: number;
  amountY?: number;
  amountWidth: number;
  amountHeight: number;
  amountTextWidth: number;
  headerY?: number;
  bodyY?: number;
  body?: PreparedWrappedContent;
  translationY?: number;
  translation?: PreparedWrappedContent;
  stickerY?: number;
  stickerSize: number;
  compactHeader: boolean;
}

// Drawing owns one plan per live card. Estimation runs without an active owner.
// Exclude per-call measurement closures; the context and font generation identify
// the measurement backend for each renderer.
type LayoutInputs = Omit<PaidCardPlanInput, 'activeCard' | 'measure' | 'measureHeight'>;
const retainedPlans = new WeakMap<
  object,
  {
    inputs: LayoutInputs;
    generation: number;
    plan: PaidCardPlan;
  }
>();

/** Release plans even when the renderer keeps the expired draw state in scratch storage. */
export function releasePaidCardPlan(activeCard: object): void {
  retainedPlans.delete(activeCard);
}

export function releasePaidCardPlans(activeCards: readonly object[]): void {
  for (const activeCard of activeCards) releasePaidCardPlan(activeCard);
}

function sameLayoutInputs(a: LayoutInputs, b: LayoutInputs): boolean {
  return (
    a.kind === b.kind &&
    a.width === b.width &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontFamily === b.fontFamily &&
    a.paddingH === b.paddingH &&
    a.paddingV === b.paddingV &&
    a.author === b.author &&
    a.authorPhotoUrl === b.authorPhotoUrl &&
    a.showAuthor === b.showAuthor &&
    a.amount === b.amount &&
    a.showAmount === b.showAmount &&
    a.membershipHeader === b.membershipHeader &&
    a.content === b.content &&
    a.translatedText === b.translatedText &&
    a.maxBodyLines === b.maxBodyLines &&
    a.outlineWidthPx === b.outlineWidthPx &&
    a.wide === b.wide &&
    a.sticker === b.sticker &&
    a.context === b.context
  );
}

/** Single measured row plan for estimation and both Canvas renderers. */
export function preparePaidCardPlan(input: PaidCardPlanInput): PaidCardPlan {
  const retain = !!input.activeCard && canRetainPaidFont(input.fontFamily);
  const retained = input.activeCard && retainedPlans.get(input.activeCard);
  if (
    retain &&
    retained &&
    retained.generation === getTextMeasurementGeneration() &&
    sameLayoutInputs(retained.inputs, input)
  )
    return retained.plan;

  const innerWidth = Math.max(1, input.width - input.paddingH * 2);
  const authorVisible = input.showAuthor && !!input.author;
  const authorFontSize = Math.round(input.fontSize * rendererLayout.authorFontScale);
  const authorFont = getFontString(authorFontSize, input.fontWeight, input.fontFamily);
  const badgeFont = getFontString(authorFontSize, 'bold', input.fontFamily);
  const measureHeight = input.measureHeight ?? measureTextHeight;
  const authorHeight = authorVisible
    ? getAuthorRowHeight(measureHeight(authorFont, authorFontSize), input.authorPhotoUrl)
    : 0;
  const photoSlot = authorVisible ? getAuthorPhotoSlotWidth(input.authorPhotoUrl) : 0;
  const amountVisible = input.showAmount && !!input.amount;
  const badgePadding = rendererLayout.superchatBadge.paddingH;
  const amountTextWidth = amountVisible ? input.measure(input.amount ?? '', badgeFont) : 0;
  const amountWidth = amountVisible
    ? Math.min(innerWidth, Math.ceil(amountTextWidth) + badgePadding * 2)
    : 0;
  const amountHeight = amountVisible
    ? authorFontSize + rendererLayout.superchatBadge.paddingV * 2
    : 0;
  const headerGap = spacing.xs;
  const remainingName = innerWidth - amountWidth - headerGap - photoSlot;
  const compactHeader =
    input.kind === 'superchat' &&
    input.wide &&
    authorVisible &&
    amountVisible &&
    remainingName >= Math.min(32, Math.ceil(input.measure(input.author ?? '', authorFont)));

  let cursor = input.paddingV;
  const plan: PaidCardPlan = {
    width: input.width,
    height: 0,
    innerWidth,
    authorMaxWidth: Math.max(
      0,
      Math.min(rendererLayout.authorNameMaxWidth, innerWidth - photoSlot)
    ),
    amountWidth,
    amountHeight,
    amountTextWidth,
    stickerSize: 0,
    compactHeader,
  };

  if (authorVisible) {
    plan.authorY = cursor;
    if (compactHeader) {
      plan.authorMaxWidth = Math.max(0, Math.min(rendererLayout.authorNameMaxWidth, remainingName));
      plan.amountX = input.paddingH + innerWidth - amountWidth;
      plan.amountY = cursor + Math.max(0, Math.floor((authorHeight - amountHeight) / 2));
      cursor += Math.max(authorHeight, amountHeight);
    } else cursor += authorHeight;
  }
  if (amountVisible && !compactHeader) {
    if (authorVisible) cursor += headerGap;
    plan.amountX = input.paddingH;
    plan.amountY = cursor;
    cursor += amountHeight;
  }
  if (input.kind === 'membership' && input.membershipHeader) {
    plan.headerY = cursor;
    cursor +=
      measureHeight(
        getFontString(Math.round(input.fontSize * 0.8), input.fontWeight, input.fontFamily),
        Math.round(input.fontSize * 0.8)
      ) + spacing.xs;
  }

  const hasContent = input.content.some(
    (segment) => segment.type === 'emoji' || (segment.content?.length ?? 0) > 0
  );
  const hasTranslation = !!input.translatedText;
  const totalLines = Math.max(0, input.maxBodyLines);
  const originalLines =
    hasContent && hasTranslation && totalLines > 1 ? totalLines - 1 : totalLines;
  if (hasContent && originalLines > 0) {
    const font = getFontString(input.fontSize, input.fontWeight, input.fontFamily);
    plan.body = prepareWrappedContent(
      input.content,
      innerWidth,
      originalLines,
      font,
      input.fontSize,
      (text, direction) => input.measure(text, font, direction),
      input.context,
      input.outlineWidthPx
    );
    if (plan.body.lines.length) {
      if (cursor > input.paddingV) cursor += spacing.xs;
      plan.bodyY = cursor;
      cursor += plan.body.height;
    }
  }
  if (hasTranslation && totalLines > (plan.body?.lines.length ?? 0)) {
    const translationSize = Math.max(1, Math.round(input.fontSize * TRANSLATION_FONT_SCALE));
    const translationFont = getFontString(translationSize, 'normal', input.fontFamily);
    plan.translation = prepareWrappedContent(
      [{ type: 'text', content: input.translatedText ?? '' }],
      innerWidth,
      Math.max(1, totalLines - (plan.body?.lines.length ?? 0)),
      translationFont,
      translationSize,
      (text, direction) => input.measure(text, translationFont, direction),
      input.context,
      input.outlineWidthPx
    );
    if (plan.translation.lines.length) {
      if (cursor > input.paddingV) cursor += TRANSLATION_GAP_PX;
      plan.translationY = cursor;
      cursor += plan.translation.height;
    }
  }
  if (input.sticker) {
    const size = Math.round(input.fontSize * rendererLayout.superchatStickerSize);
    if (cursor > input.paddingV) cursor += spacing.xs;
    plan.stickerY = cursor;
    plan.stickerSize = Math.min(size, innerWidth);
    cursor += plan.stickerSize;
  }
  plan.height = cursor + input.paddingV;
  if (input.activeCard && retain) {
    const { activeCard, measure: _measure, measureHeight: _measureHeight, ...inputs } = input;
    retainedPlans.set(activeCard, { inputs, generation: getTextMeasurementGeneration(), plan });
  } else if (input.activeCard && retained) releasePaidCardPlan(input.activeCard);
  return plan;
}
