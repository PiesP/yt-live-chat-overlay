// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect, vi } from 'vitest';

// Mock text-measure BEFORE importing the module under test
vi.mock('@renderer/text-measure', () => ({
  getFontString: vi.fn((size: number, weight: string, family: string) =>
    `${weight} ${size}px ${family}`
  ),
  measureTextWidth: vi.fn((text: string) => text.length * 8),
  measureTextHeight: vi.fn((_font: string, size: number) => Math.round(size * 1.2)),
  clearTextMeasurementCaches: vi.fn(),
  measureBoundingBoxWidth: vi.fn((m: { width: number }) => m.width),
  setTextMeasureCallback: vi.fn(),
}));

vi.mock('@renderer/canvas/shared', () => ({
  buildWrappedLines: vi.fn(
    (segments: Array<{ type: string; content: string }>, maxWidth: number) => {
      let totalWidth = 0;
      for (const seg of segments) {
        totalWidth += seg.type === 'text' ? seg.content.length * 8 : 16;
      }
      const linesPerRow = Math.max(1, Math.floor(maxWidth / 8));
      const lineCount = Math.max(1, Math.ceil((totalWidth / 8) / linesPerRow));
      return {
        lines: Array.from({ length: lineCount }, () => []),
        maxLineWidth: Math.min(maxWidth, totalWidth),
      };
    }
  ),
  measureEmojiAdvanceWidth: vi.fn(
    (
      segment: { emojiFallbackText?: string; emoji?: { fallbackText?: string } },
      emojiSize: number,
      measureText: (text: string) => number
    ) => {
      const fallbackText = segment.emojiFallbackText ?? segment.emoji?.fallbackText ?? '';
      return Math.max(emojiSize, fallbackText ? measureText(fallbackText) : 0) + 4;
    }
  ),
  measureTextAdvanceWidth: vi.fn(
    (text: string, measureText: (value: string) => number, letterSpacing = '0px') =>
      measureText(text) + Math.max(0, text.length - 1) * (Number.parseFloat(letterSpacing) || 0)
  ),
  toSharedContentSegments: vi.fn((c: unknown) => c),
}));

import {
  estimateMessageDimensions,
  estimateTranslatedMessageDimensions,
} from '@renderer/shared';
import { MEMBERSHIP_CARD_CONFIG, SUPERCHAT_CARD_CONFIG } from '@renderer/card-config';
import { getRegularCardInsets } from '@renderer/layout/card-layout';
import type { ChatMessage } from '@app-types';
import { rendererLayout, spacing } from '@util/design-tokens';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    text: 'hello',
    content: [{ type: 'text' as const, content: 'hello' }],
    kind: 'text' as const,
    timestamp: Date.now(),
    authorType: 'normal' as const,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// estimateMessageDimensions — regular text messages
// ═══════════════════════════════════════════════════════════════════════════

describe('estimateMessageDimensions — regular text', () => {
  it('returns { width, height } for a plain text message', () => {
    const msg = makeMessage({ text: 'test message', content: [{ type: 'text', content: 'test message' }] });
    const dims = estimateMessageDimensions(msg, 16, false);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
    expect(typeof dims.width).toBe('number');
    expect(typeof dims.height).toBe('number');
    // Font-relative insets keep the card compact while ensuring the glyph
    // ink is contained on all four sides.
    expect(dims.width).toBe(108);
    expect(dims.height).toBe(25);
  });

  it('includes author section when showAuthor is true and author present', () => {
    const msg = makeMessage({
      text: 'short',
      content: [{ type: 'text', content: 'short' }],
      author: 'ChannelOwner',
    });
    const noAuthor = estimateMessageDimensions(msg, 16, false);
    const withAuthor = estimateMessageDimensions(msg, 16, true);
    expect(withAuthor.height).toBeGreaterThan(noAuthor.height);
  });

  it('reserves an author photo slot only when a photo URL exists', () => {
    const withoutPhoto = makeMessage({
      text: 'x',
      content: [{ type: 'text', content: 'x' }],
      author: 'A',
    });
    const withPhoto = { ...withoutPhoto, authorPhotoUrl: 'https://yt3.ggpht.com/avatar' };

    const withoutPhotoDims = estimateMessageDimensions(withoutPhoto, 16, true);
    const withPhotoDims = estimateMessageDimensions(withPhoto, 16, true);

    expect(withPhotoDims.width - withoutPhotoDims.width).toBe(
      rendererLayout.authorPhotoSize + rendererLayout.authorPhotoShadowOutset + spacing.xs
    );
    expect(withPhotoDims.height).toBeGreaterThan(withoutPhotoDims.height);
  });

  it('same height with and without author when author absent', () => {
    const msg = makeMessage({ text: 'msg' });
    const withAuthor = estimateMessageDimensions(msg, 16, true);
    const withoutAuthor = estimateMessageDimensions(msg, 16, false);
    expect(withAuthor.height).toBe(withoutAuthor.height);
  });

  it('handles empty content', () => {
    const msg = makeMessage({ text: '', content: [{ type: 'text', content: '' }] });
    const dims = estimateMessageDimensions(msg, 16, false);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
  });

  it('handles very small font size', () => {
    const msg = makeMessage();
    const dims = estimateMessageDimensions(msg, 8, false);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
  });

  it('handles very large font size', () => {
    const msg = makeMessage();
    const dims = estimateMessageDimensions(msg, 120, false);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
  });

  it('includes letter spacing in the reserved width for depth-layer text', () => {
    const msg = makeMessage({
      text: 'MIXED CONTENT',
      content: [{ type: 'text', content: 'MIXED CONTENT' }],
    });
    const normal = estimateMessageDimensions(msg, 16, false);
    const spaced = estimateMessageDimensions(
      msg,
      16,
      false,
      'bold',
      undefined,
      undefined,
      undefined,
      '1px'
    );

    expect(spaced.width - normal.width).toBe(12);
  });

  it('reserves a missing emoji fallback when it is wider than the image slot', () => {
    const msg = makeMessage({
      text: '웃는 얼굴NEXT',
      content: [
        {
          type: 'emoji',
          emoji: {
            url: 'https://yt3.ggpht.com/missing',
            alt: ':smile:',
            fallbackText: '웃는 얼굴',
          },
        },
        { type: 'text', content: 'NEXT' },
      ],
    });
    const dims = estimateMessageDimensions(msg, 16, false);
    const expectedContentWidth = '웃는 얼굴'.length * 8 + spacing.xs + 'NEXT'.length * 8;
    const insets = getRegularCardInsets(16);

    expect(dims.width).toBe(expectedContentWidth + insets.horizontal * 2);
  });

  it('expands dual translation geometry from the actual translated text', () => {
    const msg = makeMessage({ text: 'Hi', content: [{ type: 'text', content: 'Hi' }] });
    const base = estimateMessageDimensions(msg, 16, false);
    const translated = estimateTranslatedMessageDimensions(
      msg,
      'A substantially longer translated message',
      'dual',
      { fontSize: 16, showAuthor: false }
    );

    expect(translated.width).toBeGreaterThan(base.width);
    expect(translated.height).toBeGreaterThan(base.height);
    expect(translated.translationHeight).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// estimateMessageDimensions — superchat messages
// ═══════════════════════════════════════════════════════════════════════════

describe('estimateMessageDimensions — superchat', () => {
  it('returns larger dimensions for superchat type', () => {
    const msg = makeMessage({
      kind: 'superchat',
      text: 'Super thanks!',
      author: 'Supporter',
      superChat: { amount: '$5.00', tier: 'blue' },
    });
    const dims = estimateMessageDimensions(msg, 16, true);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
  });

  it('handles superchat without author (anonymous)', () => {
    const msg = makeMessage({
      kind: 'superchat',
      text: 'Anonymous thanks',
      superChat: { amount: '$2.00', tier: 'cyan' },
    });
    const dims = estimateMessageDimensions(msg, 16, false);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.width).toBeLessThan(rendererLayout.superchatMinWidth);
    expect(dims.height).toBeGreaterThan(0);
  });

  it('never exceeds the available viewport width', () => {
    const msg = makeMessage({
      kind: 'superchat',
      text: 'very long paid message '.repeat(20),
      content: [{ type: 'text', content: 'very long paid message '.repeat(20) }],
      superChat: { amount: '$50.00', tier: 'red' },
    });

    const dims = estimateMessageDimensions(
      msg,
      32,
      false,
      'bold',
      undefined,
      undefined,
      true,
      '0px',
      0,
      240
    );

    expect(dims.width).toBeLessThanOrEqual(240);
  });

  it('handles superchat with sticker', () => {
    const msg = makeMessage({
      kind: 'superchat',
      text: 'With sticker!',
      author: 'Donor',
      superChat: {
        amount: '$10.00',
        tier: 'red',
        sticker: { url: 'https://yt3.ggpht.com/sticker', alt: '🎉' },
      },
    });
    const dims = estimateMessageDimensions(msg, 16, true);
    expect(dims.height).toBeGreaterThan(0);
  });

  it('reserves the body margin when the amount badge is hidden', () => {
    const message = makeMessage({
      kind: 'superchat',
      text: 'Thanks!',
      content: [{ type: 'text', content: 'Thanks!' }],
      superChat: { amount: '$5.00', tier: 'blue' },
    });

    const withBadge = estimateMessageDimensions(
      message,
      16,
      false,
      'bold',
      undefined,
      undefined,
      true
    );
    const withoutBadge = estimateMessageDimensions(
      message,
      16,
      false,
      'bold',
      undefined,
      undefined,
      false
    );
    const badgeHeight =
      Math.round(16 * rendererLayout.authorFontScale) +
      rendererLayout.superchatBadge.paddingV * 2;

    expect(withBadge.height - withoutBadge.height).toBe(badgeHeight + spacing.xs);
    expect(withoutBadge.height).toBe(
      rendererLayout.superchat.paddingV * 2 +
        SUPERCHAT_CARD_CONFIG.body.marginTop +
        Math.round(16 * 1.2)
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// estimateMessageDimensions — membership messages
// ═══════════════════════════════════════════════════════════════════════════

describe('estimateMessageDimensions — membership', () => {
  it('returns dimensions for membership type', () => {
    const msg = makeMessage({
      kind: 'membership',
      text: 'Welcome!',
      content: [{ type: 'text', content: 'Welcome!' }],
      membershipHeader: 'New Member',
    });
    const dims = estimateMessageDimensions(msg, 16, false);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
  });

  it('does not reserve a phantom author row when only body text is displayed', () => {
    const msg = makeMessage({
      kind: 'membership',
      text: 'x',
      content: [{ type: 'text', content: 'x' }],
    });

    const dims = estimateMessageDimensions(msg, 16, false);

    expect(dims.height).toBe(
      rendererLayout.membership.paddingV * 2 + spacing.xs + Math.round(16 * 1.2)
    );
  });

  it('lets a long membership header determine the card width', () => {
    const header = 'Membership duration '.repeat(3);
    const msg = makeMessage({
      kind: 'membership',
      text: 'x',
      content: [{ type: 'text', content: 'x' }],
      membershipHeader: header,
    });

    const dims = estimateMessageDimensions(msg, 16, false);

    expect(dims.width).toBeGreaterThan(rendererLayout.superchatMinWidth);
    expect(dims.width).toBeLessThanOrEqual(rendererLayout.superchatMaxWidth);
  });

  it('uses the configured header and body margins in membership height', () => {
    const msg = makeMessage({
      kind: 'membership',
      text: 'x',
      content: [{ type: 'text', content: 'x' }],
      membershipHeader: 'Member',
    });

    const dims = estimateMessageDimensions(msg, 16, false);
    const headerFontSize = Math.round(16 * MEMBERSHIP_CARD_CONFIG.headerTag!.fontSizeScale);

    expect(dims.height).toBe(
      rendererLayout.membership.paddingV * 2 +
        MEMBERSHIP_CARD_CONFIG.headerTag!.marginTop +
        Math.round(headerFontSize * 1.2) +
        MEMBERSHIP_CARD_CONFIG.headerTag!.marginBottom +
        MEMBERSHIP_CARD_CONFIG.body.marginTop +
        Math.round(16 * 1.2)
    );
  });

  it('handles membership with author', () => {
    const msg = makeMessage({
      kind: 'membership',
      text: 'Thanks for joining',
      content: [{ type: 'text', content: 'Thanks for joining' }],
      membershipHeader: 'Member for 6 months',
      author: 'Member',
    });
    const dims = estimateMessageDimensions(msg, 16, false);
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);
  });
});
