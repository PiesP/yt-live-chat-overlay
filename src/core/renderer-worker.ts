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
  /** Max message age for age-based fade-out (ms). */
  maxMessageAgeMs: number;
  /** Text color (CSS string) for regular messages. */
  color: string;
  /** Per-author-type color map (CSS strings). */
  authorColors: Record<string, string>;
  /** Duration multiplier for moderator/owner messages. */
  modOwnerDurationMultiplier: number;
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
  /** Author type for color selection: normal, moderator, owner, member, etc. */
  authorType?: string;
  /** Message kind: 'chat', 'superchat', 'membership', etc. */
  kind?: string;
  /** Burst speed multiplier computed by main thread (>= 1.0). */
  burstSpeedMultiplier?: number;
}

interface ActiveMessage {
  id: string;
  x: number;
  y: number;
  startX: number;
  width: number;
  height: number;
  /** Position/animation start time (includes stagger delay). */
  startTime: number;
  /** Opacity/fade start time (drain time, before stagger offset). */
  activationTime: number;
  duration: number;
  pausedDuration: number;
  laneIndex: number;
  laneSlotCount: number;
  speedTier: number;
  text: string;
  /** Per-author color CSS string. */
  color: string;
  /** Author type for stats/desaturation. */
  authorType?: string;
  /** Message kind for speed tiering. */
  kind?: string;
  /** Translated text for dual/replace display. */
  translatedText?: string;
  /** Desaturated color for far-depth layer. */
  colorOverride?: string;
}

// ── Speed tier constants ──────────────────────────────────────────────────
// MUST match @core/lane-allocator SPEED_TIER values.
const SPEED_TIER = { FAR: 0, MID: 1, NEAR: 2, BACKLOG: 3 } as const;

/** Tier split threshold: hash < this value → Near tier, else Far tier. */
const TIER_NEAR_THRESHOLD = 0.3;

/** Simple djb2-like hash of a string to a 0-1 float for tier assignment. */
function hashForTier(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) / 4294967296;
}

/** Desaturation factor for Far-tier depth layer user colors. */
const FAR_LAYER_DESATURATION_FACTOR = 0.3;

/**
 * Desaturate a hex color toward gray by a given factor.
 * factor 0 = original, 1 = full grayscale.
 * Uses luminance-preserving weights (ITU-R BT.601).
 */
function desaturateColor(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  return `rgb(${Math.round(r + (gray - r) * factor)},${Math.round(g + (gray - g) * factor)},${Math.round(b + (gray - b) * factor)})`;
}

// ── Layout constants ──────────────────────────────────────────────────────
// MUST match @core/design-tokens rendererLayout values where noted.
const HEADWAY_GAP_RATIO = 0.08; // canonical: rendererLayout.headwayGapRatio
const HEADWAY_GAP_MIN = 16; // canonical: LaneAllocator.HEADWAY_GAP_MIN_PX
const HEADWAY_GAP_MAX = 60; // canonical: LaneAllocator.HEADWAY_GAP_MAX_PX
const EXIT_PADDING_MIN = 100; // canonical: rendererLayout.exitPaddingMin
const SCROLL_DURATION_MAX_MS = 12_000; // worker-specific safety cap (no equivalent in main renderer)
const TOP_BOTTOM_DURATION_MS = 4_000; // canonical: rendererLayout.topBottomDurationMs
const LANE_COOLDOWN_MIN_MS = 500; // canonical: LaneAllocator.LANE_COOLDOWN_MIN_MS
const SAFETY_MARGIN_RATIO = 0.15; // canonical: LaneAllocator.SAFETY_MARGIN_RATIO
const EPSILON = 0.05;
const DRAIN_MAX_SKIP = 3; // canonical: CanvasRenderer.DRAIN_QUEUE_MAX_SKIP
const PADDING_V = 8; // canonical: rendererLayout.paddingV

// ── Stagger constants (must match CanvasRenderer) ─────────────────────────
const HORIZONTAL_STAGGER_PER_STEP = 40;
const HORIZONTAL_STAGGER_MAX = 200;
const STAGGER_BATCH_MAX = 3;
const STAGGER_EXP_SCALE = 25;

// ── Translation constants (must match CanvasRenderer) ─────────────────────
const TRANSLATION_FONT_SCALE = 0.75;
const TRANSLATION_GAP_PX = 2;
const TRANSLATION_OPACITY_SCALE = 0.8;

/** Inline computeScrollDuration matching @core/design-tokens. */
function computeScrollDuration(totalDistance: number, velocity: number): number {
  const velocityFloor = Math.max(
    5000, // canonical: rendererLayout.durationMin
    (100 / velocity) * 1000 // exitPaddingMin / velocity
  );
  return Math.max(velocityFloor, Math.min(30000, (totalDistance / velocity) * 1000));
}

// ── Globals (worker scope) ───────────────────────────────────────────────

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let canvas: OffscreenCanvas | null = null;
let config: WorkerConfig | null = null;
let animFrameId: number | null = null;
let isDestroyed = false;
let isPaused = false;
let pauseStartTime = 0;

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

// Collision feedback: lanes already used in this batch
const collidedLanes = new Set<number>();

// Cumulative drop counter for stats
let totalDrops = 0;

// ── Text bitmap cache ──────────────────────────────────────────────────────

const textBitmapCache = new Map<string, OffscreenCanvas>();
const TEXT_BITMAP_CACHE_MAX = 200;

/**
 * Pre-allocated opacity buckets for per-frame reuse.
 * Bucket index = Math.round(opacity * 20), yielding 21 buckets (0.00–1.00 in 0.05 steps).
 * Each frame resets bucket lengths instead of allocating new arrays, eliminating
 * per-frame GC pressure and reducing ctx.globalAlpha set/reset pairs.
 */
const OPACITY_BUCKETS = 21;
const opacityBuckets: Array<Array<{ msg: ActiveMessage; elapsed: number }>> = Array.from(
  { length: OPACITY_BUCKETS },
  () => []
);

function getCacheKey(
  text: string,
  font: string,
  color: string,
  strokeWidth: number,
  strokeColor: string
): string {
  return `${font}|${text}|${color}|${strokeWidth}|${strokeColor}`;
}

function renderCachedText(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  font: string,
  color: string,
  strokeWidth: number,
  strokeColor: string,
  x: number,
  y: number
): void {
  const key = getCacheKey(text, font, color, strokeWidth, strokeColor);
  let bitmap = textBitmapCache.get(key);

  if (!bitmap) {
    // LRU eviction
    if (textBitmapCache.size >= TEXT_BITMAP_CACHE_MAX) {
      const oldestKey = textBitmapCache.keys().next().value;
      if (oldestKey !== undefined) textBitmapCache.delete(oldestKey);
    }
    // Pre-render to offscreen canvas
    const metrics = ctx.measureText(text);
    const w =
      Math.ceil(
        Math.abs(metrics.actualBoundingBoxLeft) + Math.abs(metrics.actualBoundingBoxRight)
      ) +
      strokeWidth * 2 +
      2;
    const h =
      Math.ceil(
        Math.abs(metrics.actualBoundingBoxAscent) + Math.abs(metrics.actualBoundingBoxDescent)
      ) +
      strokeWidth * 2 +
      2;

    bitmap = new OffscreenCanvas(w, h);
    const bctx = bitmap.getContext('2d');
    if (!bctx) return;
    bctx.font = font;
    bctx.textBaseline = 'top';
    bctx.strokeStyle = strokeColor;
    bctx.lineWidth = strokeWidth;
    bctx.lineJoin = 'round';
    bctx.strokeText(text, strokeWidth + 1, strokeWidth + 1);
    bctx.fillStyle = color;
    bctx.fillText(text, strokeWidth + 1, strokeWidth + 1);

    textBitmapCache.set(key, bitmap);
  }

  ctx.drawImage(bitmap, x - 1, y - 1);
}

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
      if (config) {
        Object.assign(config, data.config as Partial<WorkerConfig>);
        textBitmapCache.clear();
      }
      break;
    case 'setPaused': {
      const shouldPause = data.paused as boolean;
      if (shouldPause && !isPaused) {
        // Pause: record the time
        pauseStartTime = performance.now();
        isPaused = true;
      } else if (!shouldPause && isPaused) {
        // Resume: accumulate paused duration and shift lane timers
        const now = performance.now();
        const pausedMs = Math.max(0, now - pauseStartTime);
        // Accumulate pausedDuration on active messages
        for (const msg of activeMessages) {
          msg.pausedDuration += pausedMs;
        }
        // Shift lane heap timers by paused duration
        shiftLaneTimers(pausedMs);
        isPaused = false;
        pauseStartTime = 0;
        // Restart render loop if stopped
        if (animFrameId === null && !isDestroyed) {
          startRenderLoop();
        }
      } else {
        isPaused = shouldPause;
      }
      break;
    }
    case 'destroy':
      handleDestroy();
      break;
  }
};

// ── Queue ─────────────────────────────────────────────────────────────────

function enqueueMessage(msg: WorkerMessage): void {
  const idx = findInsertIndex(msg.priority);
  pendingQueue.splice(idx, 0, msg);
  // Restart the render loop if it was idled.
  if (animFrameId === null && !isDestroyed) {
    startRenderLoop();
  }
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
  if (!config || !ctx) return;
  const totalPaddingV = PADDING_V * 2;
  // Height estimation from actual font metrics (or fallback)
  const font = `${config.fontWeight} ${config.fontSize}px ${config.fontFamily}`;
  ctx.font = font;
  const textMetrics = ctx.measureText('M');
  const textHeight = Math.ceil(
    textMetrics.fontBoundingBoxAscent != null
      ? textMetrics.fontBoundingBoxAscent + textMetrics.fontBoundingBoxDescent
      : config.fontSize * 1.1
  );
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

  collidedLanes.clear();
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

    // Skip lanes already used for another message in this batch (collision feedback)
    if (collidedLanes.has(i)) continue;

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
    // Mark lanes as occupied for this batch to prevent double-allocation
    collidedLanes.add(laneIndex + s);
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

/**
 * Shift all lane timers forward by `ms` to account for pause duration.
 * Mirrors renderer-canvas.ts LaneAllocator.shiftAll().
 */
function shiftLaneTimers(ms: number): void {
  for (let i = 0; i < laneHeap.length; i++) {
    const entry = laneHeap[i];
    if (entry) entry[1] += ms;
  }
  for (const [key, entry] of speedTierLanes) {
    speedTierLanes.set(key, { tier: entry.tier, until: entry.until + ms });
  }
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
    // Self-idle: stop the rAF loop when there's nothing to do.
    if (activeMessages.length === 0 && pendingQueue.length === 0 && retryQueue.length === 0) {
      animFrameId = null;
      return;
    }
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

  // ── Pre-scan: compute positions, opacity, and group into opacity buckets ──
  const mode = config.danmakuMode;
  const isScrolling = mode === 'scroll' || mode === 'reverse';
  const fadeMs = config.fadeDurationMs;
  const invFadeMs = fadeMs > 0 ? 1 / Math.max(1, fadeMs) : 0;
  const ageFadeRate = 1 / config.maxMessageAgeMs;
  const strokeWidth =
    config.outlineWidthPx > 0 && config.outlineOpacity > 0 ? config.outlineWidthPx : 0;
  const strokeColor = `rgba(0,0,0,${Math.min(1, config.outlineOpacity)})`;

  // Reset pre-allocated buckets for this frame
  for (const bucket of opacityBuckets) bucket.length = 0;

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

    // Compute opacity
    let opacity = config.opacity;
    if (msg.speedTier === SPEED_TIER.BACKLOG) {
      opacity *= config.backlogOpacityMultiplier;
    } else if (msg.speedTier === SPEED_TIER.FAR) {
      opacity *= config.depthFarOpacityMul;
    }

    if (fadeMs > 0) {
      if (isScrolling) {
        // Scrolling: fade-out only (message exits screen edge naturally)
        const remaining = msg.duration - elapsed;
        if (remaining < fadeMs) {
          opacity *= Math.max(0, remaining * invFadeMs);
        }
      } else {
        // Fixed (top/bottom): fade-in + fade-out
        if (elapsed < fadeMs) {
          opacity *= elapsed * invFadeMs;
        }
        if (elapsed > msg.duration - fadeMs) {
          opacity *= Math.max(0, (msg.duration - elapsed) * invFadeMs);
        }
      }
    }

    // Age-based fade-out: gradually fade after maxMessageAgeMs (matches renderer-canvas.ts)
    const ageRatio = Math.min(1, elapsed * ageFadeRate);
    opacity = Math.max(0, opacity * (1 - ageRatio));

    if (opacity <= 0) continue;

    const bucketIndex = Math.round(opacity * 20);
    opacityBuckets[bucketIndex]?.push({ msg, elapsed });
  }

  // ── Render pass: one ctx.globalAlpha per opacity bucket ──
  // Iterate ascending (0→20) — low opacity behind, high opacity on top.
  const baseFont = `${config.fontWeight} ${config.fontSize}px ${config.fontFamily}`;
  const translationFontSize = Math.round(config.fontSize * TRANSLATION_FONT_SCALE);
  const translationFont = `${config.fontWeight} ${translationFontSize}px ${config.fontFamily}`;
  ctx.font = baseFont;
  ctx.textBaseline = 'top';
  for (let bucketIndex = 0; bucketIndex < OPACITY_BUCKETS; bucketIndex++) {
    const entries = opacityBuckets[bucketIndex];
    if (!entries || entries.length === 0) continue;

    ctx.globalAlpha = bucketIndex / 20;

    for (const { msg } of entries) {
      // Per-message color with optional FAR desaturation
      let renderColor = msg.colorOverride || msg.color;
      if (msg.speedTier === SPEED_TIER.FAR && !msg.colorOverride) {
        renderColor = desaturateColor(renderColor, FAR_LAYER_DESATURATION_FACTOR);
        msg.colorOverride = renderColor; // cache for future frames
      }

      const sx = Math.floor(msg.x);
      const sy = Math.floor(msg.y);

      // Render main text
      renderCachedText(ctx, msg.text, baseFont, renderColor, strokeWidth, strokeColor, sx, sy);

      // Render translated text below (dual mode)
      if (msg.translatedText && msg.translatedText !== msg.text) {
        const translationColor = msg.authorType
          ? config.authorColors[msg.authorType] || renderColor
          : renderColor;
        const translationY = sy + msg.height * TRANSLATION_FONT_SCALE + TRANSLATION_GAP_PX;
        ctx.globalAlpha = (bucketIndex / 20) * TRANSLATION_OPACITY_SCALE;
        renderCachedText(
          ctx,
          msg.translatedText,
          translationFont,
          translationColor,
          strokeWidth,
          strokeColor,
          sx,
          Math.floor(translationY)
        );
        ctx.globalAlpha = bucketIndex / 20; // restore full bucket alpha
      }
    }
  }

  ctx.globalAlpha = 1;

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

    // Compute speed tier matching activateMessage for correct lane allocation
    let speedTier: number;
    if (entry.isBacklog) {
      speedTier = SPEED_TIER.BACKLOG;
    } else if (!config.depthLayersEnabled) {
      speedTier = SPEED_TIER.MID;
    } else if (config.danmakuMode !== 'scroll' && config.danmakuMode !== 'reverse') {
      speedTier = SPEED_TIER.MID;
    } else if (entry.kind === 'superchat' || entry.kind === 'membership') {
      speedTier = SPEED_TIER.NEAR;
    } else {
      const hash = hashForTier(entry.id);
      speedTier = hash < TIER_NEAR_THRESHOLD ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
    }

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

  // ── Speed tier (hash-based FAR/MID/NEAR/BACKLOG, matching main thread) ──
  let speedTier: number;
  if (msg.isBacklog) {
    speedTier = SPEED_TIER.BACKLOG;
  } else if (!config.depthLayersEnabled) {
    speedTier = SPEED_TIER.MID;
  } else if (!isScrolling) {
    speedTier = SPEED_TIER.MID;
  } else if (msg.kind === 'superchat' || msg.kind === 'membership') {
    speedTier = SPEED_TIER.NEAR;
  } else {
    const hash = hashForTier(msg.id);
    speedTier = hash < TIER_NEAR_THRESHOLD ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
  }

  // ── Speed calculation (per-tier + burst boost) ──
  let speed = config.speedPxPerSec;
  if (msg.burstSpeedMultiplier && msg.burstSpeedMultiplier > 1) {
    speed *= msg.burstSpeedMultiplier;
  }
  switch (speedTier) {
    case SPEED_TIER.FAR:
      speed = Math.max(30, speed * config.depthFarSpeedMul);
      break;
    case SPEED_TIER.NEAR:
      speed *= config.depthNearSpeedMul;
      break;
    case SPEED_TIER.BACKLOG:
      speed *= config.backlogSpeedMultiplier;
      break;
    // MID: no multiplier
  }

  // ── Exponential stagger delay (matching main thread) ──
  let staggerDelay = 0;
  if (batchIndex > 0 && isScrolling) {
    const staggeredIdx = Math.min(batchIndex, STAGGER_BATCH_MAX);
    staggerDelay = Math.round(
      Math.min(
        HORIZONTAL_STAGGER_MAX,
        staggeredIdx * -STAGGER_EXP_SCALE * Math.log(1 - Math.random())
      )
    );
  }

  // ── Horizontal stagger ──
  const horizontalStagger =
    isScrolling && batchIndex > 0
      ? Math.min(HORIZONTAL_STAGGER_MAX, batchIndex * HORIZONTAL_STAGGER_PER_STEP)
      : 0;

  let startX: number;
  if (mode === 'scroll') startX = screenWidth + horizontalStagger;
  else if (mode === 'reverse') startX = -(msg.width + horizontalStagger);
  else startX = (screenWidth - msg.width) / 2;

  // ── Duration (with computeScrollDuration matching design-tokens) ──
  let duration: number;
  if (isScrolling) {
    const totalDistance =
      mode === 'scroll'
        ? startX + msg.width + EXIT_PADDING_MIN
        : screenWidth - startX + EXIT_PADDING_MIN;
    duration = speed > 0 ? computeScrollDuration(totalDistance, speed) : 5000;
  } else {
    duration = TOP_BOTTOM_DURATION_MS;
  }

  // Moderator and owner messages stay on screen longer.
  if (msg.authorType === 'moderator' || msg.authorType === 'owner') {
    duration *= config.modOwnerDurationMultiplier;
  }

  const slotCount = Math.max(1, Math.ceil(msg.height / laneHeight));
  const laneY = placement.laneY;

  // ── Per-author color ──
  const authorColor = (msg.authorType && config.authorColors[msg.authorType]) || config.color;

  const am: ActiveMessage = {
    id: msg.id,
    x: startX,
    y: laneY,
    startX,
    width: msg.width,
    height: msg.height,
    activationTime: now,
    startTime: now + staggerDelay,
    duration,
    pausedDuration: 0,
    laneIndex: placement.laneIndex,
    laneSlotCount: slotCount,
    speedTier,
    text: msg.text,
    color: authorColor,
    ...(msg.authorType !== undefined ? { authorType: msg.authorType } : {}),
    ...(msg.kind !== undefined ? { kind: msg.kind } : {}),
    ...(msg.translatedText !== undefined ? { translatedText: msg.translatedText } : {}),
  };

  commitPlacement(
    placement.laneIndex,
    slotCount,
    now + staggerDelay,
    duration,
    speedTier,
    msg.width
  );
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
