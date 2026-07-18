// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect, vi } from 'vitest';
import { PriorityBucketQueue } from '@util/priority-bucket-queue';
import { drainStage, compactRemovedMessages, mirrorVisibleMessages } from '@renderer/canvas/render-pipeline';
import { COMPACTION_THRESHOLD_RATIO } from '@renderer/canvas/pipeline-utils';
import type { CanvasRenderContext } from '@renderer/canvas/render-pipeline';

// ── Mock factory — minimal context for drainStage ─────────────────────────

function makeDrainCtx(overrides?: Partial<CanvasRenderContext>): CanvasRenderContext {
  return {
    isReplayMode: false,
    isAntiBlockActive: () => false,
    antiBlockSince: { value: null },
    pendingQueue: new PriorityBucketQueue(),
    laneAllocator: { resetBatch: vi.fn() } as unknown as CanvasRenderContext['laneAllocator'],
    drainQueue: vi.fn(),
    // Stubs for fields not exercised by drainStage
    settings: {} as CanvasRenderContext['settings'],
    textBitmapCache: {} as CanvasRenderContext['textBitmapCache'],
    superChatGradientCache: new Map() as CanvasRenderContext['superChatGradientCache'],
    imageFetchManager: {} as CanvasRenderContext['imageFetchManager'],
    boundGetFont: () => '',
    boundMeasureTextWidth: () => 0,
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

// ═══════════════════════════════════════════════════════════════════════════
// compactRemovedMessages
// ═══════════════════════════════════════════════════════════════════════════

function makeCompactCtx(overrides?: Partial<CanvasRenderContext>): CanvasRenderContext {
  return {
    activeMessages: [],
    activeMessagesByLane: new Map(),
    expiredMessagesScratch: [],
    pendingQueue: new PriorityBucketQueue(),
    observability: { updateActiveMessages: vi.fn(), updateQueueDepth: vi.fn() } as unknown as CanvasRenderContext['observability'],
    // Stubs
    settings: {} as CanvasRenderContext['settings'],
    textBitmapCache: {} as CanvasRenderContext['textBitmapCache'],
    superChatGradientCache: new Map() as CanvasRenderContext['superChatGradientCache'],
    imageFetchManager: {} as CanvasRenderContext['imageFetchManager'],
    boundGetFont: () => '',
    boundMeasureTextWidth: () => 0,
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
      expiredMessagesScratch: [laneMsgs[0]],
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
    const snippets = updateLiveRegion.mock.calls[0]![0] as string[];
    expect(snippets).toContain('first message');
    expect(snippets).toContain('second message');
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
