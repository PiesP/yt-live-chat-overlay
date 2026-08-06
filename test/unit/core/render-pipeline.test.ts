// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HighFirstPriorityBucketQueue } from '@util/priority-bucket-queue';
import {
  compactRemovedMessages,
  drainStage,
  drawStage,
  mirrorVisibleMessages,
} from '@renderer/canvas/render-pipeline';
import type { CanvasRenderContext } from '@renderer/canvas/render-pipeline';
import type { ChatMessage } from '@app-types';
import { DEFAULT_SETTINGS } from '@settings/schema';

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
    superChatGradientCache: new Map() as CanvasRenderContext['superChatGradientCache'],
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
    observability: {} as CanvasRenderContext['observability'],
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

  it('skips drainQueue when anti-block is active and conditions not met', () => {
    const drainQueue = vi.fn();
    const ctx = makeDrainCtx({
      drainQueue,
      isAntiBlockActive: () => true,
      antiBlockSince: { value: null },
    });
    drainStage(ctx, now, dims);
    expect(ctx.antiBlockSince.value).not.toBeNull();
    expect(drainQueue).not.toHaveBeenCalled();
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
    const buckets = Array.from({ length: 21 }, () => [] as typeof message[]);
    buckets[20]!.push(message);

    drawStage(ctx, renderCtx, buckets as never);

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
      save: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const buckets = Array.from({ length: 21 }, () => [] as typeof message[]);
    buckets[20]!.push(message);

    drawStage(ctx, renderCtx, buckets as never);

    expect(mocks.renderSegment.mock.calls[0]?.[2]).toBe(22);
    expect(mocks.renderSegment.mock.calls[0]?.[3]).toBe(39);
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
    const buckets = Array.from({ length: 21 }, () => [] as typeof message[]);
    buckets[20]!.push(message);

    drawStage(ctx, renderCtx, buckets as never);

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
    observability: { updateActiveMessages: vi.fn(), updateQueueDepth: vi.fn() } as unknown as CanvasRenderContext['observability'],
    // Stubs
    settings: {} as CanvasRenderContext['settings'],
    textBitmapCache: {} as CanvasRenderContext['textBitmapCache'],
    superChatGradientCache: new Map() as CanvasRenderContext['superChatGradientCache'],
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
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeCanvasMsg({ laneIndex: i })
    ) as never[];
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
  it('skips when within throttle window', () => {
    const updateLiveRegion = vi.fn();
    const ctx = makeCompactCtx({
      activeMessages: [{ message: { text: 'hello' } }] as never[],
      lastLiveRegionUpdate: { value: performance.now() }, // just updated
      updateLiveRegion,
    });

    mirrorVisibleMessages(ctx);
    expect(updateLiveRegion).not.toHaveBeenCalled();
  });

  it('sends snippets when throttle expires', () => {
    const updateLiveRegion = vi.fn();
    const ctx = makeCompactCtx({
      activeMessages: [
        { message: { text: 'first message' } },
        { message: { text: 'second message' } },
      ] as never[],
      lastLiveRegionUpdate: { value: 0 }, // never updated
      updateLiveRegion,
    });

    mirrorVisibleMessages(ctx);
    expect(updateLiveRegion).toHaveBeenCalled();
    const messages = updateLiveRegion.mock.calls[0]![0] as Array<{
      id: string;
      text: string;
    }>;
    expect(messages.map((message) => message.text)).toEqual([
      'first message',
      'second message',
    ]);
  });

  it('skips when there are no active messages', () => {
    const updateLiveRegion = vi.fn();
    const ctx = makeCompactCtx({
      activeMessages: [],
      lastLiveRegionUpdate: { value: 0 },
      updateLiveRegion,
    });

    mirrorVisibleMessages(ctx);
    expect(updateLiveRegion).not.toHaveBeenCalled();
  });
});
