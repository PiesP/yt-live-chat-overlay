// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * RendererWorker — OffscreenCanvas-based render loop running in a Web Worker.
 *
 * Offloads Canvas 2D rendering from the main thread. The main thread handles
 * DOM observation, API polling, and translation; the worker runs its own rAF
 * loop for rendering, lane allocation, and message lifecycle.
 *
 * ## Protocol
 *
 * Main → Worker:
 *   { type: 'init', canvas: OffscreenCanvas, config: WorkerConfig }
 *   { type: 'resize', width: number, height: number }
 *   { type: 'addMessages', messages: WorkerMessage[] }
 *   { type: 'updateConfig', config: Partial<WorkerConfig> }
 *   { type: 'setPaused', paused: boolean }
 *   { type: 'destroy' }
 *
 * Worker → Main:
 *   { type: 'stats', activeMessages: number, drops: number }
 *
 * ## WorkerConfig
 *
 * A minimal subset of OverlaySettings needed by the render loop.
 * The main thread serializes relevant settings into this flat config shape.
 */

/// <reference lib="webworker" />

// ── Types ─────────────────────────────────────────────────────────────────

interface WorkerConfig {
  /** Pixels per second scroll speed (100–400). */
  speedPxPerSec: number;
  /** Font size in logical pixels. */
  fontSize: number;
  /** Font weight string: 'normal' | 'bold'. */
  fontWeight: string;
  /** CSS font-family value. */
  fontFamily: string;
  /** Base opacity (0–1). */
  opacity: number;
  /** Vertical lane spacing in px. */
  laneSpacing: number;
  /** Safe zone top ratio (0–1). */
  safeTop: number;
  /** Safe zone bottom ratio (0–1). */
  safeBottom: number;
  /** Max concurrent messages on screen. */
  maxConcurrentMessages: number;
  /** Danmaku mode. */
  danmakuMode: 'scroll' | 'reverse' | 'top' | 'bottom';
  /** Backlog speed multiplier. */
  backlogSpeedMultiplier: number;
  /** Depth layers enabled. */
  depthLayersEnabled: boolean;
  /** Far-layer speed multiplier. */
  depthFarSpeedMul: number;
  /** Near-layer speed multiplier. */
  depthNearSpeedMul: number;
  /** Far-layer opacity multiplier. */
  depthFarOpacityMul: number;
  /** Backlog opacity multiplier. */
  backlogOpacityMultiplier: number;
  /** Fade-out duration in ms. */
  fadeDurationMs: number;
  /** Text color (CSS string) for regular messages. */
  color: string;
  /** Outline width in px. */
  outlineWidthPx: number;
  /** Outline opacity. */
  outlineOpacity: number;
}

interface WorkerMessage {
  /** Unique message ID. */
  id: string;
  /** Plain text content (pre-extracted). */
  text: string;
  /** Width/height estimates (computed on main thread). */
  width: number;
  height: number;
  /** Priority: 100+ = superchat, 80 = membership, 50 = mod/owner, 0 = normal. */
  priority: number;
  /** Whether this is a backlog (past chat) message. */
  isBacklog: boolean;
  /** Translated text (if available). */
  translatedText?: string;
}

interface ActiveMessage {
  id: string;
  x: number;
  y: number;
  startX: number;
  width: number;
  height: number;
  startTime: number;
  duration: number;
  pausedDuration: number;
  laneIndex: number;
  laneSlotCount: number;
  speedTier: number;
  text: string;
  /** Desaturated color for far-depth layer. */
  colorOverride?: string;
}

// ── Speed tier constants ──────────────────────────────────────────────────
// MUST match @core/lane-allocator SPEED_TIER values.
const SPEED_TIER = { FAR: 0, MID: 1, NEAR: 2, BACKLOG: 3 } as const;

// ── Layout constants ──────────────────────────────────────────────────────
// MUST match @core/design-tokens rendererLayout values where noted.
const HEADWAY_GAP_RATIO = 0.08;
const HEADWAY_GAP_MIN = 16;
const HEADWAY_GAP_MAX = 60;
const EXIT_PADDING_MIN = 100; // canonical: rendererLayout.exitPaddingMin
const SCROLL_DURATION_MAX_MS = 12_000; // worker-specific safety cap (no equivalent in main renderer)
const TOP_BOTTOM_DURATION_MS = 5_000;
const LANE_COOLDOWN_MIN_MS = 500;
const SAFETY_MARGIN_RATIO = 0.15;
const EPSILON = 0.05;
const DRAIN_MAX_SKIP = 3;
const PADDING_V = 4;

// ── Globals (worker scope) ───────────────────────────────────────────────

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let canvas: OffscreenCanvas | null = null;
let config: WorkerConfig | null = null;
let animFrameId: number | null = null;
let isDestroyed = false;
let isPaused = false;

// Active messages (renderable)
const activeMessages: ActiveMessage[] = [];

// Pending queue (waiting for lane allocation)
const pendingQueue: WorkerMessage[] = [];
let pendingQueueOffset = 0;
const retryQueue: WorkerMessage[] = [];

// Lane allocator state — heap of [laneIndex, availableAtMs]
let laneHeap: [number, number][] = [];
const laneIndexToHeapIndex = new Map<number, number>();
let laneHeight = 0;
let numLanes = 0;
// Track speed-tier occupancy per lane
const speedTierLanes = new Map<number, { tier: number; until: number }>();

// Cumulative drop counter for stats
let totalDrops = 0;

// ── Message handler ───────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const data = e.data as Record<string, unknown>;
  const type = data.type as string;

  switch (type) {
    case 'init': {
      config = data.config as WorkerConfig;
      canvas = data.canvas as OffscreenCanvas;
      ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        self.postMessage({ type: 'error', error: 'Failed to get 2D context' });
        return;
      }
      initLanes(data.width as number, data.height as number);
      startRenderLoop();
      self.postMessage({ type: 'ready' });
      break;
    }
    case 'resize':
      initLanes(data.width as number, data.height as number);
      break;
    case 'addMessages': {
      const msgs = data.messages as WorkerMessage[];
      for (const m of msgs) enqueueMessage(m);
      break;
    }
    case 'updateConfig':
      if (config) Object.assign(config, data.config as Partial<WorkerConfig>);
      break;
    case 'setPaused':
      isPaused = data.paused as boolean;
      break;
    case 'destroy':
      handleDestroy();
      break;
  }
};

// ── Queue ─────────────────────────────────────────────────────────────────

function enqueueMessage(msg: WorkerMessage): void {
  const idx = findInsertIndex(msg.priority);
  pendingQueue.splice(idx, 0, msg);
}

function findInsertIndex(priority: number): number {
  let lo = pendingQueueOffset;
  let hi = pendingQueue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const p = pendingQueue[mid]?.priority ?? 0;
    if (p >= priority) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── Lane allocator (simplified 3-phase, adapted from LaneAllocator) ───────

function initLanes(_width: number, height: number): void {
  if (!config) return;
  const totalPaddingV = PADDING_V * 2;
  // Height estimation: fontSize * 1.4 for line-height, plus padding
  const textHeight = Math.ceil(config.fontSize * 1.4);
  laneHeight = Math.max(1, textHeight + totalPaddingV + config.laneSpacing);

  const usableHeight = height * (1 - config.safeTop - config.safeBottom);
  numLanes = Math.max(1, Math.floor(usableHeight / laneHeight));

  laneHeap = [];
  laneIndexToHeapIndex.clear();
  speedTierLanes.clear();

  const now = performance.now();
  for (let i = 0; i < numLanes; i++) {
    laneHeap.push([i, now]);
    laneIndexToHeapIndex.set(i, i);
  }
  // Build 4-ary min-heap
  for (let i = Math.floor((laneHeap.length - 2) / 4); i >= 0; i--) {
    siftDown(i);
  }
}

function resetBatch(): void {
  // Prune expired speed-tier entries
  const now = performance.now();
  for (const [k, v] of speedTierLanes) {
    if (v.until <= now) speedTierLanes.delete(k);
  }
}

function findPlacement(
  msgHeight: number,
  speedTier: number
): {
  laneIndex: number;
  waitMs: number;
  laneY: number;
} | null {
  if (laneHeap.length === 0) return null;

  const now = performance.now();
  const slotCount = Math.max(1, Math.ceil(msgHeight / laneHeight));
  const result = allocateSingleLane(now, speedTier, slotCount);
  if (!result) return null;

  const laneY = (config?.safeTop ?? 0) * (canvas?.height ?? 0) + result.laneIndex * laneHeight;
  return { ...result, laneY };
}

function allocateSingleLane(
  now: number,
  speedTier: number,
  slotCount: number
): { laneIndex: number; waitMs: number } | null {
  if (laneHeap.length === 0) return null;

  const maxWaitMs = SCROLL_DURATION_MAX_MS;
  let firstBusy: { laneIndex: number; waitMs: number } | null = null;
  let speedMatched: { laneIndex: number; waitMs: number } | null = null;
  let zeroWaitCandidates: number[] | null = null;

  // Phase 1: zero-wait lanes
  for (let i = 0; i < numLanes - slotCount + 1; i++) {
    // Check tier compatibility for all slots
    let tierOk = true;
    for (let s = 0; s < slotCount; s++) {
      const active = speedTierLanes.get(i + s);
      if (active && active.until > now && !areTiersCompatible(speedTier, active.tier)) {
        tierOk = false;
        break;
      }
    }
    if (!tierOk) continue;

    const avail = getSlotAvailableAt(i);
    if (avail === undefined) continue;
    const wait = Math.max(0, Math.ceil(avail - now));
    if (wait > 0) {
      if (!firstBusy) firstBusy = { laneIndex: i, waitMs: wait };
      const active = speedTierLanes.get(i);
      if ((!speedMatched || wait < speedMatched.waitMs) && active && active.tier === speedTier) {
        speedMatched = { laneIndex: i, waitMs: wait };
      }
      continue;
    }

    // Zero-wait lane found — epsilon-greedy
    if (Math.random() < EPSILON) {
      if (!zeroWaitCandidates) {
        zeroWaitCandidates = [];
        for (let j = i + 1; j < numLanes - slotCount + 1; j++) {
          const availJ = getSlotAvailableAt(j);
          if (availJ !== undefined && Math.max(0, Math.ceil(availJ - now)) === 0) {
            let jTierOk = true;
            for (let s = 0; s < slotCount; s++) {
              const activeJ = speedTierLanes.get(j + s);
              if (activeJ && activeJ.until > now && !areTiersCompatible(speedTier, activeJ.tier)) {
                jTierOk = false;
                break;
              }
            }
            if (jTierOk) zeroWaitCandidates.push(j);
          }
        }
      }
      if (zeroWaitCandidates.length > 0) continue;
    }
    return { laneIndex: i, waitMs: 0 };
  }

  // Phase 2: same-tier busy
  if (speedMatched && speedMatched.waitMs <= maxWaitMs) return speedMatched;
  // Phase 3: fastest-free
  if (firstBusy && firstBusy.waitMs <= maxWaitMs) return firstBusy;
  return null;
}

function areTiersCompatible(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

function getSlotAvailableAt(laneIndex: number): number | undefined {
  if (laneIndex < 0 || laneIndex >= numLanes) return undefined;
  const heapIdx = laneIndexToHeapIndex.get(laneIndex);
  if (heapIdx === undefined || heapIdx >= laneHeap.length) return undefined;
  return laneHeap[heapIdx]?.[1];
}

function commitPlacement(
  laneIndex: number,
  slotCount: number,
  startTime: number,
  durationMs: number,
  speedTier: number,
  msgWidth?: number
): void {
  const occupancyMs = computeOccupancyMs(durationMs, msgWidth);
  const nextAvailable = startTime + occupancyMs;
  const until = startTime + durationMs;

  for (let s = 0; s < slotCount; s++) {
    speedTierLanes.set(laneIndex + s, { tier: speedTier, until });
    updateLane(laneIndex + s, nextAvailable);
  }
}

function computeOccupancyMs(durationMs: number, msgWidthPx?: number): number {
  if (msgWidthPx === undefined) {
    return (
      durationMs + Math.max(LANE_COOLDOWN_MIN_MS, Math.round(durationMs * SAFETY_MARGIN_RATIO))
    );
  }
  const screenWidth = canvas?.width ?? 1920;
  const headwayPx = Math.max(
    HEADWAY_GAP_MIN,
    Math.min(HEADWAY_GAP_MAX, Math.round(msgWidthPx * HEADWAY_GAP_RATIO))
  );
  const totalDistance = screenWidth + msgWidthPx + EXIT_PADDING_MIN;
  const fraction = (msgWidthPx + headwayPx) / totalDistance;
  return Math.round(fraction * durationMs);
}

function updateLane(laneIdx: number, availableAt: number): void {
  const heapIdx = laneIndexToHeapIndex.get(laneIdx);
  if (heapIdx === undefined) return;
  const entry = laneHeap[heapIdx];
  if (!entry) return;
  entry[1] = availableAt;
  // Sift-down after increasing the value
  siftDown(heapIdx);
}

// ── 4-ary min-heap helpers ───────────────────────────────────────────────

function siftDown(idx: number): void {
  const heap = laneHeap;
  const n = heap.length;
  const base = idx * 4; // 4-ary: children at 4*i+1, 4*i+2, 4*i+3, 4*i+4

  while (true) {
    let smallest = idx;
    let smallestVal = heap[idx]?.[1] ?? Infinity;

    for (let child = base + 1; child <= base + 4 && child < n; child++) {
      const childVal = heap[child]?.[1] ?? Infinity;
      if (childVal < smallestVal) {
        smallest = child;
        smallestVal = childVal;
      }
    }

    if (smallest === idx) break;

    // Swap
    const tmp = heap[idx];
    const smallestEntry = heap[smallest];
    if (!tmp || !smallestEntry) break;
    heap[idx] = smallestEntry;
    heap[smallest] = tmp;
    laneIndexToHeapIndex.set(smallestEntry[0], idx);
    laneIndexToHeapIndex.set(tmp[0], smallest);
  }
}

// ── Render loop ───────────────────────────────────────────────────────────

let statsFrameCounter = 0;

function startRenderLoop(): void {
  if (animFrameId !== null) return;

  function frame(_t: number): void {
    if (isDestroyed) return;
    renderFrame();
    animFrameId = requestAnimationFrame(frame);
  }

  animFrameId = requestAnimationFrame(frame);
}

function renderFrame(): void {
  if (!ctx || !canvas || !config || isPaused) return;

  const now = performance.now();
  const width = canvas.width;
  const height = canvas.height;

  // Apply pending batch state
  resetBatch();

  // Drain queue
  drainQueue(now, width, height);

  // Cleanup expired
  cleanupExpired(now);

  // Clear canvas
  ctx.clearRect(0, 0, width, height);

  if (activeMessages.length === 0) {
    // Stats every ~60 frames
    statsFrameCounter++;
    if (statsFrameCounter >= 60) {
      statsFrameCounter = 0;
      self.postMessage({ type: 'stats', activeMessages: 0, drops: totalDrops });
    }
    return;
  }

  // Render pass
  const mode = config.danmakuMode;
  const isScrolling = mode === 'scroll' || mode === 'reverse';
  const font = `${config.fontWeight} ${config.fontSize}px ${config.fontFamily}`;

  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.fillStyle = config.color;

  for (let i = 0; i < activeMessages.length; i++) {
    const msg = activeMessages[i];
    if (!msg) continue;
    const elapsed = now - msg.startTime - msg.pausedDuration;
    if (elapsed < 0) continue;

    const progress = Math.min(1, Math.max(0, elapsed / msg.duration));

    // Update position
    if (mode === 'scroll') {
      const dist = msg.startX + msg.width + EXIT_PADDING_MIN;
      msg.x = msg.startX - progress * dist;
    } else if (mode === 'reverse') {
      const dist = width - msg.startX + EXIT_PADDING_MIN;
      msg.x = msg.startX + progress * dist;
    }

    // Opacity
    let opacity = config.opacity;
    if (msg.speedTier === SPEED_TIER.BACKLOG) {
      opacity = config.backlogOpacityMultiplier;
    } else if (msg.speedTier === SPEED_TIER.FAR) {
      opacity = config.depthFarOpacityMul;
    }

    const fadeMs = config.fadeDurationMs;
    if (fadeMs > 0) {
      if (isScrolling) {
        const remaining = msg.duration - elapsed;
        if (remaining < fadeMs) {
          opacity *= Math.max(0, remaining / fadeMs);
        }
      } else {
        const remaining = Math.max(0, msg.duration - elapsed);
        if (remaining < fadeMs) {
          opacity *= remaining / Math.max(1, fadeMs);
        }
      }
    }

    if (opacity <= 0) continue;

    const sx = Math.floor(msg.x);
    const sy = Math.floor(msg.y);

    ctx.globalAlpha = opacity;

    // Outline
    if (config.outlineWidthPx > 0 && config.outlineOpacity > 0) {
      ctx.strokeStyle = `rgba(0,0,0,${Math.min(1, config.outlineOpacity)})`;
      ctx.lineWidth = config.outlineWidthPx;
      ctx.lineJoin = 'round';
      ctx.strokeText(msg.text, sx, sy);
    }

    ctx.fillText(msg.text, sx, sy);
    ctx.globalAlpha = 1;
  }

  // Stats
  statsFrameCounter++;
  if (statsFrameCounter >= 60) {
    statsFrameCounter = 0;
    self.postMessage({ type: 'stats', activeMessages: activeMessages.length, drops: totalDrops });
  }
}

// ── Queue drain ───────────────────────────────────────────────────────────

function drainQueue(now: number, width: number, height: number): void {
  if (!config) return;

  let skipped = 0;
  let batchIndex = 0;

  while (
    pendingQueueOffset < pendingQueue.length &&
    activeMessages.length < config.maxConcurrentMessages &&
    skipped <= DRAIN_MAX_SKIP
  ) {
    const entry = pendingQueue[pendingQueueOffset++];
    if (!entry) continue;

    const speedTier = entry.isBacklog ? SPEED_TIER.BACKLOG : SPEED_TIER.MID;
    const placement = findPlacement(entry.height, speedTier);

    if (!placement) {
      skipped++;
      totalDrops++;
      retryQueue.push(entry);
      continue;
    }

    activateMessage(entry, now, placement, batchIndex, width, height);
    skipped = 0;
    batchIndex++;
  }

  // Merge retries
  if (retryQueue.length > 0) {
    for (const e of retryQueue) {
      const idx = findInsertIndex(e.priority);
      pendingQueue.splice(idx, 0, e);
    }
    retryQueue.length = 0;
  }
}

function activateMessage(
  msg: WorkerMessage,
  now: number,
  placement: { laneIndex: number; waitMs: number; laneY: number },
  batchIndex: number,
  screenWidth: number,
  _screenHeight: number
): void {
  if (!config) return;

  const mode = config.danmakuMode;
  const isScrolling = mode === 'scroll' || mode === 'reverse';

  // Horizontal stagger
  const stagger = isScrolling && batchIndex > 0 ? Math.min(200, batchIndex * 40) : 0;

  let startX: number;
  if (mode === 'scroll') startX = screenWidth + stagger;
  else if (mode === 'reverse') startX = -(msg.width + stagger);
  else startX = (screenWidth - msg.width) / 2;

  // Speed
  let speed = config.speedPxPerSec;
  if (msg.isBacklog) {
    speed *= config.backlogSpeedMultiplier;
  } else if (config.depthLayersEnabled) {
    // Hash-based tier assignment (simplified: use priority as proxy)
    if (msg.priority >= 80) {
      speed *= config.depthNearSpeedMul;
    }
  }

  // Duration
  let duration: number;
  if (isScrolling) {
    const dist =
      mode === 'scroll'
        ? startX + msg.width + EXIT_PADDING_MIN
        : screenWidth - startX + EXIT_PADDING_MIN;
    duration = Math.min(SCROLL_DURATION_MAX_MS, Math.round((dist / speed) * 1_000));
  } else {
    duration = TOP_BOTTOM_DURATION_MS;
  }

  const speedTier = msg.isBacklog ? SPEED_TIER.BACKLOG : SPEED_TIER.MID;
  const slotCount = Math.max(1, Math.ceil(msg.height / laneHeight));
  const laneY = placement.laneY;

  const am: ActiveMessage = {
    id: msg.id,
    x: startX,
    y: laneY,
    startX,
    width: msg.width,
    height: msg.height,
    startTime: now,
    duration,
    pausedDuration: 0,
    laneIndex: placement.laneIndex,
    laneSlotCount: slotCount,
    speedTier,
    text: msg.translatedText ?? msg.text,
  };

  commitPlacement(placement.laneIndex, slotCount, now, duration, speedTier, msg.width);
  activeMessages.push(am);
}

// ── Cleanup ───────────────────────────────────────────────────────────────

function cleanupExpired(now: number): void {
  let writeIdx = 0;
  for (let i = 0; i < activeMessages.length; i++) {
    const m = activeMessages[i];
    if (!m) continue;
    if (now - m.startTime - m.pausedDuration >= m.duration) continue;
    activeMessages[writeIdx++] = m;
  }
  activeMessages.length = writeIdx;
}

function handleDestroy(): void {
  isDestroyed = true;
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  ctx = null;
  canvas = null;
  activeMessages.length = 0;
  pendingQueue.length = 0;
}

// Signal ready
self.postMessage({ type: 'ready' });
