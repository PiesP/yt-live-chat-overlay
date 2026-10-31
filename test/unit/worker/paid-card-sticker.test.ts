// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';
import { SUPERCHAT_CARD_CONFIG, toWorkerConfig } from '@renderer/card-config';
import { preparePaidCardPlan } from '@renderer/layout/paid-card-plan';
import { renderPaidCardWorker } from '@renderer/worker/renderer';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { describe, expect, it, vi } from 'vite-plus/test';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'self', {
    value: globalThis,
    writable: true,
    configurable: true,
  });
});

const source: ChatMessage = {
  kind: 'superchat',
  authorType: 'normal',
  timestamp: 0,
  text: '',
  content: [],
  superChat: {
    tier: 'blue',
    amount: '',
    sticker: { url: 'https://example.test/cat.png', alt: '猫ステッカー' },
  },
};
const plan = preparePaidCardPlan({
  kind: 'superchat',
  width: 240,
  fontSize: 24,
  fontWeight: 'bold',
  fontFamily: 'sans-serif',
  paddingH: 24,
  paddingV: 20,
  showAuthor: false,
  showAmount: false,
  content: [],
  maxBodyLines: 3,
  outlineWidthPx: 0,
  wide: true,
  sticker: true,
  measure: (value) => value.length * 8,
});

function paint(image?: ImageBitmap) {
  const fillText = vi.fn();
  const drawImage = vi.fn();
  const gradient = { addColorStop: vi.fn() } as unknown as CanvasGradient;
  const ctx = {
    font: 'bold 24px sans-serif',
    direction: 'ltr',
    textAlign: 'left',
    textBaseline: 'top',
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    strokeText: vi.fn(),
    fillText,
    drawImage,
    measureText: vi.fn((value: string) => ({
      width: Array.from(value).length * 8,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
    })),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  } as unknown as OffscreenCanvasRenderingContext2D;
  const noCache = { get: (): undefined => undefined, set: (): boolean => false };
  renderPaidCardWorker(
    ctx,
    {
      kind: 'superchat',
      authorType: 'normal',
      text: '',
      content: [],
      superChatAmount: '',
      superChatStickerUrl: source.superChat?.sticker?.url,
      superChatStickerAlt: source.superChat?.sticker?.alt,
    } as never,
    [],
    plan.width,
    plan.height,
    0,
    0,
    0,
    toWorkerConfig(SUPERCHAT_CARD_CONFIG, source, DEFAULT_SETTINGS),
    24,
    'bold',
    'sans-serif',
    0,
    0,
    noCache as never,
    noCache as never,
    noCache as never,
    { get: () => image },
    () => 'bold 24px sans-serif',
    (value) => value.length * 8,
    new Map(),
    1,
    'wide',
    undefined,
    false
  );
  return { fillText, drawImage };
}

describe('Worker paid-card sticker fallback', () => {
  it('paints the source alt in the reserved row while pending or failed', () => {
    expect(plan.bodyY).toBeUndefined();
    expect(plan.stickerY).toBe(20);
    for (const image of [undefined, { width: 0, height: 0 } as ImageBitmap]) {
      const painted = paint(image);
      expect(painted.drawImage).not.toHaveBeenCalled();
      expect(painted.fillText.mock.calls.map(([value]) => value).join('')).toContain(
        '猫ステッカー'
      );
    }
  });

  it('aspect-fits a loaded non-square bitmap with no fallback label', () => {
    const painted = paint({ width: 80, height: 40 } as ImageBitmap);
    expect(painted.fillText).not.toHaveBeenCalled();
    expect(painted.drawImage).toHaveBeenCalledOnce();
    const call = painted.drawImage.mock.calls[0];
    expect(call?.[3]).toBe(plan.stickerSize);
    expect(call?.[4]).toBe(plan.stickerSize / 2);
  });
});
