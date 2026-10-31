// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';
import { toSharedContentSegments } from '@renderer/canvas/shared';
import { MEMBERSHIP_CARD_CONFIG, resolveCardBorderAlpha } from '@renderer/card-config';
import { preparePaidCardPlan, type PaidCardPlanInput } from '@renderer/layout/paid-card-plan';
import { estimateMessageDimensions, estimateTranslatedMessageDimensions } from '@renderer/shared';
import { describe, expect, it } from 'vite-plus/test';

const measure = (text: string): number => Array.from(text).length * 10;
const measurement = { width: measure, height: (_font: string, size: number) => size };

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    kind: 'superchat',
    authorType: 'normal',
    timestamp: 0,
    author: 'Author',
    text: 'Hello',
    content: [{ type: 'text', content: 'Hello' }],
    superChat: { tier: 'blue', amount: '$5' },
    ...overrides,
  };
}

function plan(overrides: Partial<PaidCardPlanInput> = {}) {
  return preparePaidCardPlan({
    kind: 'superchat',
    width: 240,
    fontSize: 24,
    fontWeight: 'bold',
    fontFamily: 'sans-serif',
    paddingH: 24,
    paddingV: 20,
    author: 'Author',
    showAuthor: true,
    amount: '$5',
    showAmount: true,
    content: [{ type: 'text', content: 'Hello' }],
    maxBodyLines: 3,
    outlineWidthPx: 0,
    wide: true,
    sticker: false,
    measure,
    measureHeight: measurement.height,
    ...overrides,
  });
}

describe('production paid-card plan', () => {
  it('reserves the amount first and contains the 240/24/220+24 overflow fixture', () => {
    const result = plan({ amount: 'X'.repeat(22) });
    expect(result.amountWidth).toBe(192);
    expect((result.amountX ?? 0) + result.amountWidth).toBeLessThanOrEqual(216);
    expect(result.compactHeader).toBe(false);
    expect(result.bodyY).toBeGreaterThan(result.amountY ?? 0);
  });

  it('shares the metadata row when it fits and falls back for long localized amounts', () => {
    const wide = plan();
    const stacked = plan({ wide: false });
    expect(wide.compactHeader).toBe(true);
    expect(wide.height).toBeLessThan(stacked.height);
    expect(wide.authorY).toBeDefined();
    expect(wide.amountY).toBeDefined();
    expect(wide.bodyY).toBeGreaterThan(wide.authorY ?? 0);
    for (const amount of ['¥123,456,789,000', 'د.إ.‏ ١٢٣٬٤٥٦٬٧٨٩']) {
      const narrow = plan({ amount, width: 240 });
      expect(narrow.compactHeader).toBe(false);
      expect((narrow.amountX ?? 0) + narrow.amountWidth).toBeLessThanOrEqual(216);
    }
  });

  it('shares one total line budget across mixed emoji original and translated text', () => {
    const content = toSharedContentSegments([
      { type: 'text', content: 'A long message with many words and ' },
      { type: 'emoji', emoji: { url: '', alt: '👩‍👩‍👧‍👧', fallbackText: '👩‍👩‍👧‍👧' } },
    ]);
    const result = plan({
      content,
      translatedText: '번역된 긴 문장과 إضافي نص طويل',
      maxBodyLines: 3,
    });
    expect(
      (result.body?.lines.length ?? 0) + (result.translation?.lines.length ?? 0)
    ).toBeLessThanOrEqual(3);
    expect(result.translationY).toBeGreaterThan(result.bodyY ?? 0);
  });

  it('omits empty body gaps for amount-only and hidden-author cards', () => {
    const amountOnly = plan({ author: undefined, showAuthor: false, content: [], sticker: false });
    expect(amountOnly.authorY).toBeUndefined();
    expect(amountOnly.bodyY).toBeUndefined();
    expect(amountOnly.height).toBe(20 + amountOnly.amountHeight + 20);
    const sticker = plan({
      author: undefined,
      showAuthor: false,
      content: [],
      sticker: true,
      width: 90,
    });
    expect(sticker.stickerSize).toBeLessThanOrEqual(sticker.innerWidth);
    expect(sticker.stickerY).toBeGreaterThan(sticker.amountY ?? 0);
  });

  it('reserves an emoji-only body and keeps the original when a one-line dual budget cannot fit both', () => {
    const emojiContent = toSharedContentSegments([
      { type: 'emoji', emoji: { url: '', alt: '🙂', fallbackText: '🙂' } },
    ]);
    const result = plan({ content: emojiContent, translatedText: '번역', maxBodyLines: 1 });
    expect(result.body?.lines).toHaveLength(1);
    expect(result.translation).toBeUndefined();
  });

  it('keeps estimator and translated geometry on the same prepared plan', () => {
    const source = message({
      author: 'Long name 👩‍💻 ここに',
      superChat: { tier: 'blue', amount: '$123,456' },
    });
    const original = estimateMessageDimensions(
      source,
      24,
      true,
      'bold',
      'sans-serif',
      { superchat: 3 },
      true,
      '0px',
      0,
      240,
      undefined,
      '#00000000',
      'scroll',
      measurement,
      'wide'
    );
    const dual = estimateTranslatedMessageDimensions(source, '번역된 긴 메시지', 'dual', {
      fontSize: 24,
      showAuthor: true,
      fontWeight: 'bold',
      fontFamily: 'sans-serif',
      maxBodyLines: { superchat: 3 },
      showSuperChatAmount: true,
      availableWidth: 240,
      measurement,
      superChatLayout: 'wide',
    });
    expect(original.width).toBeLessThanOrEqual(240);
    expect(dual.width).toBe(original.width);
    expect(dual.translationHeight).toBeGreaterThan(0);
    expect(dual.height).toBeGreaterThan(original.height);
  });

  it('uses static membership decoration under reduced motion and caller opacity', () => {
    const border = MEMBERSHIP_CARD_CONFIG.pulsingBorder;
    expect(border).toBeDefined();
    if (!border) return;
    const staticAlpha = resolveCardBorderAlpha(0, border, true);
    expect(resolveCardBorderAlpha(750, border, true)).toBe(staticAlpha);
    expect(resolveCardBorderAlpha(750, border, false)).not.toBe(staticAlpha);
    expect(staticAlpha * 0.25).toBeLessThan(staticAlpha);
  });
});
