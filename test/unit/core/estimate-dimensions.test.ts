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
  toSharedContentSegments: vi.fn((c: unknown) => c),
}));

import { estimateMessageDimensions } from '@renderer/shared';
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
    // Regular comment rows have no fixed vertical padding; laneSpacing is
    // the sole control over the distance between adjacent rows.
    expect(dims.height).toBe(19);
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
    expect(dims.height).toBeGreaterThan(0);
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
