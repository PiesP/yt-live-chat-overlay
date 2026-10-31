// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage } from '@app-types';
import { LruMap } from '@piesp/browser-core/util';
import {
  type CanvasRenderContext,
  cleanupAndBucketStage,
  compactRemovedMessages,
  drainStage,
  drawStage,
  mirrorVisibleMessages,
} from '@renderer/canvas/render-pipeline';
import { GRADIENT_CACHE_MAX } from '@renderer/constants';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { HighFirstPriorityBucketQueue } from '@util/priority-bucket-queue';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

describe('scrolling motion on the main Canvas path', () => {
  it('keeps a hidden active clock until expiry without sending it to a draw bucket', () => {
    const message = {
      message: { id: 'hidden', text: 'hidden', kind: 'text', content: [] },
      reflowHidden: true,
      startTime: 0,
      fadeStartTime: 0,
      pausedDuration: 0,
      duration: 1000,
      x: 100,
      y: 100,
      width: 100,
      height: 20,
      speedTier: 1,
    };
    const releaseMessage = vi.fn();
    const ctx = makeDrainCtx({
      settings: DEFAULT_SETTINGS,
      activeMessages: [message] as never[],
      messageActivator: { releaseMessage } as never,
      farOpacityBuckets: Array.from({ length: 32 }, () => []),
      midOpacityBuckets: Array.from({ length: 32 }, () => []),
      nearOpacityBuckets: Array.from({ length: 32 }, () => []),
    });
    cleanupAndBucketStage(ctx, 500, { width: 640, height: 360 }, 'scroll');
    expect(ctx.midOpacityBuckets.every((bucket) => bucket.length === 0)).toBe(true);
    expect(releaseMessage).not.toHaveBeenCalled();
    cleanupAndBucketStage(ctx, 1000, { width: 640, height: 360 }, 'scroll');
    expect(releaseMessage).toHaveBeenCalledWith(message);
  });
  it.each([
    ['scroll', false, 0],
    ['top', false, 0],
    ['scroll', true, 300],
  ] as const)(
    'keeps a reflowed %s message visible with reduced motion=%s and pause=%s',
    (mode, reduced, pausedDuration) => {
      const message = {
        message: { id: 'fade', text: 'fade', kind: 'text', content: [] },
        startTime: 7736 - pausedDuration,
        fadeStartTime: 4000 - pausedDuration,
        pausedDuration,
        duration: 4000,
        invDuration: 1 / 4000,
        startX: 640,
        x: 640,
        y: 0,
        width: 100,
        height: 20,
        speedTier: 1,
      };
      const ctx = makeDrainCtx({
        settings: { ...DEFAULT_SETTINGS, danmakuMode: mode },
        activeMessages: [message] as never[],
        isReducedMotionActive: reduced,
        farOpacityBuckets: Array.from({ length: 32 }, () => []),
        midOpacityBuckets: Array.from({ length: 32 }, () => []),
        nearOpacityBuckets: Array.from({ length: 32 }, () => []),
        cachedOpacityConfig: {
          baseOpacity: 1,
          fadeDurationMs: 300,
          invFadeDuration: 1 / 300,
          backlogOpacityMultiplier: 1,
          depthLayersEnabled: false,
          depthFarOpacityMul: 1,
          ageFadeRate: 0,
        },
      });
      cleanupAndBucketStage(ctx, 10_000, { width: 640, height: 360 }, mode);
      expect(
        ctx.midOpacityBuckets.slice(1).some((bucket) => bucket.includes(message as never))
      ).toBe(true);
    }
  );
  it.each([false, true])(
    'uses fixed position only when effective reduced motion is %s',
    (reducedMotion) => {
      const message = {
        message: {
          id: 'motion',
          text: 'motion',
          kind: 'text',
          content: [{ type: 'text', content: 'motion' }],
        },
        startTime: 0,
        fadeStartTime: 0,
        pausedDuration: 0,
        duration: 2000,
        invDuration: 1 / 2000,
        startX: 640,
        x: 640,
        y: 0,
        width: 100,
        height: 20,
        speedTier: 1,
      };
      const ctx = makeDrainCtx({
        settings: DEFAULT_SETTINGS,
        activeMessages: [message] as never[],
        isReducedMotionActive: reducedMotion,
        farOpacityBuckets: Array.from({ length: 32 }, () => []),
        midOpacityBuckets: Array.from({ length: 32 }, () => []),
        nearOpacityBuckets: Array.from({ length: 32 }, () => []),
        cachedOpacityConfig: {
          baseOpacity: 1,
          fadeDurationMs: 0,
          invFadeDuration: 0,
          backlogOpacityMultiplier: 1,
          depthLayersEnabled: false,
          depthFarOpacityMul: 1,
          ageFadeRate: 0,
        },
      });
      cleanupAndBucketStage(ctx, 500, { width: 640, height: 360 }, 'scroll');
      expect(message.x).toBe(
        reducedMotion ? 270 : 640 - 0.25 * (640 + 100 + DEFAULT_SETTINGS.exitPaddingPx)
      );
    }
  );
});

const mocks = vi.hoisted(() => ({
  renderPaidCard: vi.fn(),
  renderRegularMessage: vi.fn(),
  renderSegment: vi.fn(),
}));

vi.mock('@renderer/canvas/card-renderers', () => ({
  renderPaidCard: mocks.renderPaidCard,
}));

vi.mock('@renderer/canvas/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/canvas/shared')>()),
  renderRegularMessage: mocks.renderRegularMessage,
  renderSegment: mocks.renderSegment,
}));

// ── Mock factory — minimal context for drainStage ─────────────────────────

function makeDrainCtx(overrides?: Partial<CanvasRenderContext>): CanvasRenderContext {
  return {
    isReplayMode: false,
    isAntiBlockActive: () => false,
    antiBlockSince: { value: null },
    pendingQueue: new HighFirstPriorityBucketQueue(),
    laneAllocator: { resetBatch: vi.fn() } as unknown as CanvasRenderContext['laneAllocator'],
    drainQueue: vi.fn(),
    // Stubs for fields not exercised by drainStage
    settings: {} as CanvasRenderContext['settings'],
    textBitmapCache: {} as CanvasRenderContext['textBitmapCache'],
    superChatGradientCache: new LruMap(GRADIENT_CACHE_MAX),
    imageFetchManager: {} as CanvasRenderContext['imageFetchManager'],
    boundGetFont: () => '',
    boundMeasureTextWidth: () => 0,
    regularRenderConfig: {} as CanvasRenderContext['regularRenderConfig'],
    activeMessages: [],
    activeMessagesByLane: new Map(),
    farOpacityBuckets: [],
    midOpacityBuckets: [],
    nearOpacityBuckets: [],
    expiredMessagesScratch: [],
    messageActivator: {} as CanvasRenderContext['messageActivator'],
    cachedOpacityConfig: {} as CanvasRenderContext['cachedOpacityConfig'],
    observability: {
      onMessagesPresented: vi.fn(),
      onPresentationAttributionUnknown: vi.fn(),
    } as unknown as CanvasRenderContext['observability'],
    isReducedMotionActive: false,
    lastLiveRegionUpdate: { value: 0 },
    updateLiveRegion: vi.fn(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// drainStage
// ═══════════════════════════════════════════════════════════════════════════

describe('drainStage', () => {
  const now = 1000;
  const dims = { width: 1920, height: 1080 };

  it('calls drainQueue immediately when anti-block is inactive', () => {
    const drainQueue = vi.fn();
    const ctx = makeDrainCtx({ drainQueue });
    drainStage(ctx, now, dims);
    expect(ctx.antiBlockSince.value).toBeNull();
    expect(drainQueue).toHaveBeenCalledWith(now);
  });

  it('resets antiBlockSince and calls drainQueue in normal mode', () => {
    const drainQueue = vi.fn();
    const ctx = makeDrainCtx({
      drainQueue,
      antiBlockSince: { value: 500 },
    });
    drainStage(ctx, now, dims);
    expect(ctx.antiBlockSince.value).toBeNull();
    expect(drainQueue).toHaveBeenCalledWith(now);
  });

  it('does not start an anti-block interval when there is no pending message', () => {
    const drainQueue = vi.fn();
    const ctx = makeDrainCtx({
      drainQueue,
      isAntiBlockActive: () => true,
      antiBlockSince: { value: null },
    });
    drainStage(ctx, now, dims);
    expect(ctx.antiBlockSince.value).toBeNull();
    expect(drainQueue).not.toHaveBeenCalled();
  });

  it('lets a backlog Super Chat bypass anti-block using the canonical priority', () => {
    const drainQueue = vi.fn();
    const ctx = makeDrainCtx({
      drainQueue,
      isAntiBlockActive: () => true,
      antiBlockSince: { value: now - 100 },
    });
    ctx.pendingQueue.enqueue({ kind: 'superchat', isBacklog: true } as never, 150);

    drainStage(ctx, now, dims);

    expect(drainQueue).toHaveBeenCalledWith(now);
  });

  it('force-drains when anti-block has persisted beyond max duration', () => {
    const drainQueue = vi.fn();
    // ANTI_BLOCK_MAX_DURATION_MS = 30000 (from constants)
    const longAgo = now - 31000;
    const ctx = makeDrainCtx({
      drainQueue,
      isAntiBlockActive: () => true,
      antiBlockSince: { value: longAgo },
    });
    // Need a high-priority message in queue for the check to pass
    // Actually, forceDrain only needs peek() to return something + time elapsed >= max
    // Let me add a message to the pending queue
    ctx.pendingQueue.enqueue({ kind: 'text', isBacklog: false } as never, 0);

    // Mock performance.now for deterministic testing
    vi.spyOn(performance, 'now').mockReturnValue(now);

    drainStage(ctx, now, dims);
    expect(drainQueue).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('drains for high-priority messages even when anti-block is active', () => {
    const drainQueue = vi.fn();
    const ctx = makeDrainCtx({
      drainQueue,
      isAntiBlockActive: () => true,
      antiBlockSince: { value: now - 1000 }, // short time, not expired
    });
    // Enqueue a superchat (priority 100, which is >= ANTI_BLOCK_PRIORITY_THRESHOLD=90)
    ctx.pendingQueue.enqueue({ kind: 'superchat', isBacklog: false } as never, 100);

    drainStage(ctx, now, dims);
    expect(drainQueue).toHaveBeenCalled();
  });

  it('skips anti-block entirely in replay mode', () => {
    const drainQueue = vi.fn();
    const ctx = makeDrainCtx({
      drainQueue,
      isReplayMode: true,
      isAntiBlockActive: () => true, // would block in normal mode
    });
    drainStage(ctx, now, dims);
    expect(drainQueue).toHaveBeenCalledWith(now);
  });
});

describe('drawStage', () => {
  beforeEach(() => {
    mocks.renderPaidCard.mockClear();
    mocks.renderRegularMessage.mockClear();
    mocks.renderSegment.mockClear();
  });

  it('records first presentation only after an eligible completed draw and mirrors that frame', () => {
    const original: ChatMessage = {
      id: 'same-id',
      text: 'short…',
      canonicalText: 'full original',
      kind: 'text',
      content: [{ type: 'text', content: 'short…' }],
      timestamp: 1,
      authorType: 'normal',
    };
    const message = {
      message: original,
      renderMessage: original,
      duration: 1_000,
      width: 100,
      height: 20,
      x: 20,
      y: 20,
      speedTier: 1,
      _frameElapsed: -1,
    };
    const presented = vi.fn();
    const updateLiveRegion = vi.fn();
    const ctx = makeDrainCtx({
      settings: { ...DEFAULT_SETTINGS, translationEnabled: true, translationMode: 'dual' },
      activeMessages: [message] as never[],
      observability: {
        onMessagesPresented: presented,
      } as unknown as CanvasRenderContext['observability'],
      updateLiveRegion,
      imageFetchManager: {
        emojiCache: { get: vi.fn() },
        authorPhotoCache: { get: vi.fn() },
        stickerCache: { get: vi.fn() },
      } as unknown as CanvasRenderContext['imageFetchManager'],
    });
    const renderCtx = {
      globalAlpha: 1,
      measureText: vi.fn(() => ({
        actualBoundingBoxAscent: 0,
        actualBoundingBoxDescent: 16,
        width: 100,
      })),
      save: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const buckets = Array.from({ length: 32 }, () => [] as (typeof message)[]);
    const dims = { width: 640, height: 360 };

    buckets[1]!.push(message);
    drawStage(ctx, renderCtx, buckets as never, 1, dims);
    message._frameElapsed = 100;
    message.x = 640;
    drawStage(ctx, renderCtx, buckets as never, 2, dims);
    message.x = 20;
    buckets[1]!.length = 0;
    buckets[0]!.push(message);
    drawStage(ctx, renderCtx, buckets as never, 3, dims);
    expect(presented).not.toHaveBeenCalled();
    mirrorVisibleMessages(ctx, 1_000, 3);
    expect(updateLiveRegion).not.toHaveBeenCalled();

    buckets[0]!.length = 0;
    buckets[1]!.push(message);
    drawStage(ctx, renderCtx, buckets as never, 4, dims);
    mirrorVisibleMessages(ctx, 1_500, 4);
    expect(presented).toHaveBeenCalledOnce();
    expect(updateLiveRegion.mock.lastCall?.[0]).toMatchObject([
      { id: 'same-id', text: 'full original' },
    ]);

    Object.assign(message, { reflowHidden: true });
    drawStage(ctx, renderCtx, buckets as never, 5, dims);
    mirrorVisibleMessages(ctx, 2_000, 5);
    expect(updateLiveRegion).toHaveBeenCalledOnce();
    Object.assign(message, {
      reflowHidden: false,
      message: { ...original, text: 'edited', canonicalText: 'full edit' },
      translatedText: 'translation',
    });
    drawStage(ctx, renderCtx, buckets as never, 6, dims);
    mirrorVisibleMessages(ctx, 2_500, 6);
    expect(presented).toHaveBeenCalledOnce();
    expect(updateLiveRegion.mock.lastCall?.[0]).toMatchObject([
      { id: 'same-id', text: 'full edit — translation' },
    ]);

    message._frameElapsed = 1_000;
    drawStage(ctx, renderCtx, buckets as never, 7, dims);
    mirrorVisibleMessages(ctx, 3_000, 7);
    expect(updateLiveRegion).toHaveBeenCalledTimes(2);
  });

  it('does not attribute a timed-out Worker recovery twice but counts fresh placement', () => {
    const makeMessage = (id: string) => {
      const body: ChatMessage = {
        id,
        text: id,
        content: [{ type: 'text', content: id }],
        timestamp: 1,
        kind: 'text',
        authorType: 'normal',
      };
      return {
        message: body,
        renderMessage: body,
        duration: 1_000,
        width: 100,
        height: 20,
        x: 20,
        y: 20,
        speedTier: 1,
        _frameElapsed: 100,
        wasPresented: false,
        presentationAccountingUnknown: id === 'timeout',
      };
    };
    const timeout = makeMessage('timeout');
    const fresh = makeMessage('fresh');
    const presented = vi.fn();
    const unknown = vi.fn();
    const ctx = makeDrainCtx({
      settings: DEFAULT_SETTINGS,
      observability: {
        onMessagesPresented: presented,
        onPresentationAttributionUnknown: unknown,
      } as unknown as CanvasRenderContext['observability'],
      imageFetchManager: {
        emojiCache: { get: vi.fn() },
        authorPhotoCache: { get: vi.fn() },
        stickerCache: { get: vi.fn() },
      } as unknown as CanvasRenderContext['imageFetchManager'],
    });
    const buckets = Array.from({ length: 32 }, () => [] as (typeof timeout)[]);
    buckets[1]!.push(timeout, fresh);
    drawStage(ctx, { globalAlpha: 1 } as CanvasRenderingContext2D, buckets as never, 1, {
      width: 640,
      height: 360,
    });
    expect(timeout.wasPresented).toBe(true);
    expect(timeout.presentationAccountingUnknown).toBeUndefined();
    expect(fresh.wasPresented).toBe(true);
    expect(presented).toHaveBeenCalledOnce();
    expect(unknown).toHaveBeenCalledOnce();
  });

  it('passes author background color and unchanged bounds to regular message rendering', () => {
    const original: ChatMessage = {
      id: 'moderator-message',
      kind: 'text',
      text: 'Original',
      content: [{ type: 'text', content: 'Original' }],
      timestamp: 1,
      authorType: 'moderator',
    };
    const message = {
      message: original,
      renderMessage: original,
      startTime: 0,
      fadeStartTime: 0,
      duration: 1000,
      invDuration: 0.001,
      width: 200,
      height: 40,
      startX: 0,
      x: 10.9,
      y: 20.8,
      pausedDuration: 0,
      laneIndex: 0,
      staggerDelay: 0,
      speedTier: 1,
      _frameElapsed: 100,
    };
    const ctx = makeDrainCtx({
      settings: DEFAULT_SETTINGS,
      imageFetchManager: {
        emojiCache: { get: vi.fn() },
        authorPhotoCache: { get: vi.fn() },
        stickerCache: { get: vi.fn() },
      } as unknown as CanvasRenderContext['imageFetchManager'],
    });
    const renderCtx = { globalAlpha: 1 } as CanvasRenderingContext2D;
    const buckets = Array.from({ length: 21 }, () => [] as (typeof message)[]);
    buckets[20]!.push(message);

    drawStage(ctx, renderCtx, buckets as never, 1_000, { width: 640, height: 360 });

    expect(mocks.renderRegularMessage).toHaveBeenCalledOnce();
    expect(mocks.renderRegularMessage).toHaveBeenCalledWith(
      renderCtx,
      original,
      10,
      20,
      expect.objectContaining({
        backgroundColor: DEFAULT_SETTINGS.backgroundColors.moderator,
        messageWidth: 200,
        messageHeight: 40,
      }),
      expect.anything(),
      expect.objectContaining({ get: expect.any(Function) }),
      expect.any(Function),
      expect.objectContaining({ get: expect.any(Function) }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      undefined,
      undefined
    );
  });

  it('keeps dual translations inside the regular message horizontal padding', () => {
    const original: ChatMessage = {
      id: 'translated-message',
      kind: 'text',
      text: 'Original',
      content: [{ type: 'text', content: 'Original' }],
      timestamp: 1,
      authorType: 'normal',
    };
    const message = {
      message: original,
      renderMessage: original,
      startTime: 0,
      fadeStartTime: 0,
      duration: 1000,
      invDuration: 0.001,
      width: 200,
      height: 40,
      startX: 0,
      x: 10.9,
      y: 20.8,
      pausedDuration: 0,
      laneIndex: 0,
      staggerDelay: 0,
      speedTier: 1,
      translatedText: 'Translated',
      translatedRenderMessage: {
        ...original,
        text: 'Translated',
        content: [{ type: 'text' as const, content: 'Translated' }],
      },
      translationHeight: 15,
      _frameElapsed: 100,
    };
    const ctx = makeDrainCtx({
      settings: {
        ...DEFAULT_SETTINGS,
        translationEnabled: true,
        translationMode: 'dual',
      },
      imageFetchManager: {
        emojiCache: { get: vi.fn() },
        authorPhotoCache: { get: vi.fn() },
        stickerCache: { get: vi.fn() },
      } as unknown as CanvasRenderContext['imageFetchManager'],
    });
    const renderCtx = {
      globalAlpha: 1,
      measureText: vi.fn(() => ({
        actualBoundingBoxAscent: 0,
        actualBoundingBoxDescent: 16,
        width: 100,
      })),
      save: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const buckets = Array.from({ length: 21 }, () => [] as (typeof message)[]);
    buckets[20]!.push(message);

    drawStage(ctx, renderCtx, buckets as never, 1_000, { width: 640, height: 360 });

    expect(mocks.renderSegment.mock.calls[0]?.[2]).toBe(22);
    expect(mocks.renderSegment.mock.calls[0]?.[3]).toBe(43);
  });

  it('isolates paid-card canvas state and replaces its body with translated text', () => {
    const original: ChatMessage = {
      id: 'paid-message',
      kind: 'superchat',
      text: 'Original',
      content: [{ type: 'text', content: 'Original' }],
      timestamp: 1,
      authorType: 'normal',
      superChat: { amount: '$5.00', tier: 'blue' },
    };
    const message = {
      message: original,
      renderMessage: original,
      startTime: 0,
      fadeStartTime: 0,
      duration: 1000,
      invDuration: 0.001,
      width: 200,
      height: 80,
      startX: 0,
      x: 10,
      y: 20,
      pausedDuration: 0,
      laneIndex: 0,
      staggerDelay: 0,
      speedTier: 1,
      translatedText: 'Translated',
      translatedRenderMessage: {
        ...original,
        text: 'Translated',
        content: [{ type: 'text' as const, content: 'Translated' }],
      },
      _frameElapsed: 100,
    };
    const ctx = makeDrainCtx({
      settings: {
        ...DEFAULT_SETTINGS,
        translationEnabled: true,
        translationMode: 'replace',
      },
      imageFetchManager: {
        emojiCache: { get: vi.fn() },
        authorPhotoCache: { get: vi.fn() },
        stickerCache: { get: vi.fn() },
      } as unknown as CanvasRenderContext['imageFetchManager'],
    });
    const renderCtx = {
      globalAlpha: 1,
      save: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const buckets = Array.from({ length: 21 }, () => [] as (typeof message)[]);
    buckets[20]!.push(message);

    drawStage(ctx, renderCtx, buckets as never, 1_000, { width: 640, height: 360 });

    const paidMessage = mocks.renderPaidCard.mock.calls[0]?.[1] as ChatMessage;
    expect(paidMessage.text).toBe('Translated');
    expect(paidMessage.content).toEqual([{ type: 'text', content: 'Translated' }]);
    expect(renderCtx.save).toHaveBeenCalledOnce();
    expect(renderCtx.restore).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// compactRemovedMessages
// ═══════════════════════════════════════════════════════════════════════════

function makeCompactCtx(overrides?: Partial<CanvasRenderContext>): CanvasRenderContext {
  return {
    activeMessages: [],
    activeMessagesByLane: new Map(),
    expiredMessagesScratch: [],
    pendingQueue: new HighFirstPriorityBucketQueue(),
    observability: {
      updateActiveMessages: vi.fn(),
      updateQueueDepth: vi.fn(),
      onMessagesPresented: vi.fn(),
    } as unknown as CanvasRenderContext['observability'],
    // Stubs
    settings: {} as CanvasRenderContext['settings'],
    textBitmapCache: {} as CanvasRenderContext['textBitmapCache'],
    superChatGradientCache: new LruMap(GRADIENT_CACHE_MAX),
    imageFetchManager: {} as CanvasRenderContext['imageFetchManager'],
    boundGetFont: () => '',
    boundMeasureTextWidth: () => 0,
    regularRenderConfig: {} as CanvasRenderContext['regularRenderConfig'],
    farOpacityBuckets: [],
    midOpacityBuckets: [],
    nearOpacityBuckets: [],
    messageActivator: {} as CanvasRenderContext['messageActivator'],
    cachedOpacityConfig: {} as CanvasRenderContext['cachedOpacityConfig'],
    antiBlockSince: { value: null },
    laneAllocator: {} as CanvasRenderContext['laneAllocator'],
    isReplayMode: false,
    isReducedMotionActive: false,
    isAntiBlockActive: () => false,
    drainQueue: vi.fn(),
    lastLiveRegionUpdate: { value: 0 },
    updateLiveRegion: vi.fn(),
    ...overrides,
  };
}

function makeCanvasMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    laneIndex: 0,
    slotCount: 1,
    laneArrayIndices: undefined,
    ...overrides,
  };
}

describe('compactRemovedMessages', () => {
  it('truncates array to writeIdx when below compaction threshold', () => {
    const msgs = [
      makeCanvasMsg({ laneIndex: 0 }),
      makeCanvasMsg({ laneIndex: 1 }),
      makeCanvasMsg({ laneIndex: 2 }),
    ] as never[];
    const ctx = makeCompactCtx({
      activeMessages: [...msgs],
      expiredMessagesScratch: [],
    });

    compactRemovedMessages(ctx, 1, 3);
    expect(ctx.activeMessages.length).toBe(1);
  });

  it('allocates fresh array via slice when above compaction threshold', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => makeCanvasMsg({ laneIndex: i })) as never[];
    const ctx = makeCompactCtx({
      activeMessages: [...msgs],
      expiredMessagesScratch: [],
    });

    // writeIdx (1) < oldLength (10) * THRESHOLD (0.5) → slice path
    compactRemovedMessages(ctx, 1, 10);
    expect(ctx.activeMessages.length).toBe(1);
  });

  it('removes expired messages from lane map via swap-pop', () => {
    const laneMsgs = [
      makeCanvasMsg({ laneIndex: 5, slotCount: 1, laneArrayIndices: [0] }),
      makeCanvasMsg({ laneIndex: 5, slotCount: 1, laneArrayIndices: [1] }),
    ] as never[];

    const activeMessages = [...laneMsgs, makeCanvasMsg({ laneIndex: 6 })] as never[];
    const laneMap = new Map<number, never[]>();
    laneMap.set(5, [...laneMsgs]);

    const ctx = makeCompactCtx({
      activeMessages,
      activeMessagesByLane: laneMap,
      expiredMessagesScratch: [laneMsgs[0]!],
    });

    compactRemovedMessages(ctx, 2, 3);

    // Lane 5 should now have 1 message (the non-expired one)
    const lane5 = ctx.activeMessagesByLane.get(5);
    expect(lane5?.length).toBe(1);
  });

  it('deletes empty lanes after compaction', () => {
    const laneMap = new Map<number, never[]>();
    laneMap.set(3, []); // empty lane should be deleted

    const ctx = makeCompactCtx({
      activeMessages: [],
      activeMessagesByLane: laneMap,
      expiredMessagesScratch: [],
    });

    compactRemovedMessages(ctx, 0, 0);
    expect(ctx.activeMessagesByLane.has(3)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mirrorVisibleMessages
// ═══════════════════════════════════════════════════════════════════════════

describe('mirrorVisibleMessages', () => {
  it('uses the accepted body for the accessible alternative', () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const updateLiveRegion = vi.fn();
    const ctx = makeCompactCtx({
      activeMessages: [
        {
          message: { id: 'one', text: 'short…', canonicalText: 'short and long' },
          _lastDrawnFrame: 1_000,
        },
      ] as never[],
      lastLiveRegionUpdate: { value: 0 },
      updateLiveRegion,
    });
    mirrorVisibleMessages(ctx, 1_000, 1_000);
    expect(updateLiveRegion.mock.calls[0]?.[0]).toMatchObject([
      { id: 'one', text: 'short and long' },
    ]);
    nowSpy.mockRestore();
  });
  it('skips when within throttle window', () => {
    const updateLiveRegion = vi.fn();
    const ctx = makeCompactCtx({
      activeMessages: [{ message: { text: 'hello' } }] as never[],
      lastLiveRegionUpdate: { value: performance.now() }, // just updated
      updateLiveRegion,
    });

    mirrorVisibleMessages(ctx, performance.now(), 1);
    expect(updateLiveRegion).not.toHaveBeenCalled();
  });

  it('sends snippets when throttle expires', () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const updateLiveRegion = vi.fn();
    const ctx = makeCompactCtx({
      activeMessages: [
        { message: { text: 'first message' }, _lastDrawnFrame: 1_000 },
        { message: { text: 'second message' }, _lastDrawnFrame: 1_000 },
      ] as never[],
      lastLiveRegionUpdate: { value: 0 }, // never updated
      updateLiveRegion,
    });

    mirrorVisibleMessages(ctx, 1_000, 1_000);
    expect(updateLiveRegion).toHaveBeenCalled();
    const messages = updateLiveRegion.mock.calls[0]![0] as Array<{
      id: string;
      text: string;
    }>;
    expect(messages.map((message) => message.text)).toEqual(['first message', 'second message']);
    nowSpy.mockRestore();
  });

  it('skips when there are no active messages', () => {
    const updateLiveRegion = vi.fn();
    const ctx = makeCompactCtx({
      activeMessages: [],
      lastLiveRegionUpdate: { value: 0 },
      updateLiveRegion,
    });

    mirrorVisibleMessages(ctx, 1_000, 1_000);
    expect(updateLiveRegion).not.toHaveBeenCalled();
  });
});
