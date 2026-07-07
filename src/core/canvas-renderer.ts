// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * CanvasRenderer — Canvas 2D-based renderer.
 *
 * Uses requestAnimationFrame instead of CSS @keyframes animations.
 * Each frame computes positions with Math.floor() to snap to integer pixel
 * coordinates, eliminating the sub-pixel text jitter inherent in CSS
 * transform interpolation.
 *
 * Extends RendererBase for shared state machine, rate limiting, burst
 * detection, and lane allocation.
 *
 * Stagger delay: messages in the same drainQueue batch are given an
 * exponentially-distributed time offset (0-200ms) before they start
 * scrolling. This spreads simultaneous entries across time, preventing
 * the visual clumping that occurs when multiple messages enter from the
 * right edge in the same frame. During the stagger period the message
 * sits at the start position (right edge) but is not rendered. The lane
 * allocator reservation is unaffected — the lane is locked from the
 * actual commit time, not the visual start time.
 */

import type { ChatMessage, DropReason, OverlayDimensions, OverlaySettings } from '@app-types';
import { ByteLimitedCache } from '@core/byte-limited-cache';
import { renderPaidCard } from '@core/canvas-card-renderers';
import { COMPACTION_THRESHOLD_RATIO, fastRandom } from '@core/canvas-pipeline';
import {
  drawRoundRect,
  getDisplayText,
  renderRegularMessage,
  renderSegment,
  toSharedContentSegments,
  warmTextBitmapCache,
} from '@core/canvas-rendering-shared';
import { isImageReady } from '@core/canvas-worker-bridge';
import { MEMBERSHIP_CARD_CONFIG, SUPERCHAT_CARD_CONFIG } from '@core/card-config';
import { ChannelLanguageMemory } from '@core/channel-language-memory';
import { getTranslatableText } from '@core/chat-message-helpers';
import { computeScrollDuration, rendererLayout, statusBarLayout } from '@core/design-tokens';
import { clearSafeAnimationFrame, forEachSlot, SCREEN_READER_CSS } from '@core/dom';
import { ImageFetchManager } from '@core/image-fetch-manager';
import { computeBaseHeadwayPx } from '@core/lane-allocation-shared';
import type { LanePlacement } from '@core/lane-allocator';
import { LanguageDetectorService } from '@core/language-detector-service';
import { createLogger } from '@core/logging';
import { LruMap } from '@core/lru-map';
import { MessageActivator } from '@core/message-activator';
import type { Overlay } from '@core/overlay';
import { PriorityBucketQueue } from '@core/priority-bucket-queue';
import type { ConnectionStatus } from '@core/renderer-base';
import { RendererBase } from '@core/renderer-base';
import {
  ANTI_BLOCK_MAX_DURATION_MS,
  ANTI_BLOCK_PRIORITY_THRESHOLD,
  type CanvasMessage,
  GRADIENT_CACHE_MAX,
  HORIZONTAL_STAGGER_MAX,
  HORIZONTAL_STAGGER_PER_STEP,
  hashStringForTier,
  OPACITY_BUCKET_COUNT,
  SIN_LUT_SCALE,
  SIN_TABLE,
  SPEED_TIER,
  STAGGER_BATCH_MAX,
  STAGGER_EXP_SCALE,
  STAGGER_QUEUE_HIGH,
  STAGGER_QUEUE_MED,
  TEMPORAL_BLEND_ALPHA,
  TIER_NEAR_THRESHOLD,
  TRANSLATION_FONT_SCALE,
  TRANSLATION_GAP_PX,
  TRANSLATION_OPACITY_SCALE,
} from '@core/renderer-constants';
import {
  computeAgeFadeRate,
  computeInvFadeDuration,
  computeMessageOpacity,
  enqueueWithOverflow,
  estimateMessageDimensions as sharedEstimateDimensions,
} from '@core/renderer-shared';
import { RenderWorkerManager } from '@core/renderer-worker-manager';
import { schedulerPostTask, yieldIfOverBudget } from '@core/scheduler-utils';
import {
  clearTextMeasurementCaches,
  getFontString,
  measureTextHeight,
  measureTextWidth,
} from '@core/text-measure';
import { TranslationService } from '@core/translation-service';

import { WebGL2ImageRenderer } from '@core/webgl2-image-renderer';

const log = createLogger('RendererCanvas');

/** Shared CSS string applied to all canvas elements — ensures consistent sizing and event delegation. */
const CANVAS_CSS =
  'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;text-rendering:optimizeSpeed';

/** Alpha for the connected status dot — subtle when connected. */
const DISCONNECTED_DOT_ALPHA = 0.15;

export class CanvasRenderer extends RendererBase {
  private canvas: HTMLCanvasElement | null = null;
  private canvasClickHandler: ((e: MouseEvent) => void) | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  /** Pre-computed 1/maxMessageAgeMs to avoid per-frame division in opacity calc. */
  private readonly ageFadeRate = computeAgeFadeRate(this.settings.maxMessageAgeMs);
  /** Pre-computed 1/fadeDurationMs — corrected in constructor from settings. */
  private invFadeDuration = 0;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  /** Debounce flag for emoji-load-triggered rAF restarts. */
  private needsRerender = false;
  /** Image fetch manager for loading and caching emoji, author photos, and stickers. */
  private imageFetchManager!: ImageFetchManager;

  private readonly activeMessages: CanvasMessage[] = [];
  /** Lane-indexed active messages for O(1) lane-scoped collision checks. */
  private readonly activeMessagesByLane = new Map<number, CanvasMessage[]>();
  private readonly pendingQueue = new PriorityBucketQueue();

  /** Cached prefers-reduced-motion media query result. */
  private reducedMotionQuery: MediaQueryList | null = null;
  private reducedMotion = false;

  /** Last devicePixelRatio seen — used to detect DPR changes. */
  private lastDpr = 0;
  /** When the idle condition is first met, record the timestamp so the loop
   * continues for a grace period before stopping. Prevents start/stop
   * thrashing during sparse chat intervals. */
  private idleSince: number | null = null;
  /**
   * Timestamp (performance.now) when anti-block was first activated in the
   * current consecutive block sequence. Used to force-drainQueue after
   * a maximum duration, preventing indefinite message suppression during
   * sustained lane saturation.
   */
  private antiBlockSince: number | null = null;
  /** Offscreen recovery poll interval ID. */
  private offscreenPollInterval: ReturnType<typeof setInterval> | null = null;
  /** IntersectionObserver for detecting canvas offscreen state. */
  private offscreenObserver: IntersectionObserver | null = null;
  /** Current connection health status for overlay feedback. */
  private connectionStatus: ConnectionStatus = 'connected';
  /** Bounding box of the last-rendered status bar pill, for click hit testing. */
  private statusBarHitRegion: { x: number; y: number; w: number; h: number } | null = null;
  /** Visually-hidden live region for connection status announcements. */
  private statusRegion: HTMLDivElement | null = null;
  private translationService: TranslationService;
  private messageActivator: MessageActivator;
  private languageDetector: LanguageDetectorService | null = null;
  private channelMemory: ChannelLanguageMemory | null = null;
  private sourceDetectionDone = false;
  private sourceSampleBuffer: string[] = [];
  private static readonly SOURCE_SAMPLE_COUNT = 8;

  /** Max translations to apply per frame to avoid single-frame spikes during chat bursts. */
  private readonly translationBatchSize: number;

  /**
   * Pending translation results collected between frames.
   * Promise callbacks push here; renderFrame() applies up to
   * translationBatchSize per frame, leaving the rest for
   * subsequent frames to avoid frame spikes during chat bursts.
   */
  private pendingTranslations: Array<{ msg: CanvasMessage; text: string | null }> = [];
  /** Read index for incremental pendingTranslations drain (avoids splice allocation). */
  private pendingTranslationReadIdx = 0;

  /**
   * Scratch array for cleanupExpiredMessages — hoisted to avoid per-frame allocation.
   * Reset via .length = 0 at the start of each call.
   */
  private expiredMessagesScratch: CanvasMessage[] = [];

  /**
   * OffscreenCanvas Web Worker for off-main-thread rendering.
   * When active, the worker owns the render loop; the main thread
   * handles message ingress, translation, and image loading only.
   * Falls back to main-thread rendering when unavailable.
   */
  private workerManager!: RenderWorkerManager;

  /**
   * Text bitmap cache: pre-rendered text with outline as offscreen canvas.
   * Key = `${font}|${text}|${color}|${strokeWidth}|${strokeColor}`.
   * On cache hit, drawImage() replaces fillText()+strokeText() in the hot path.
   * Bounded to 200 entries (FIFO eviction with LRU touch on re-insert) to prevent unbounded memory growth
   * in long-running streams.
   */
  private readonly textBitmapCache = new ByteLimitedCache<HTMLCanvasElement>(
    this.settings.textCacheMb * 1_000_000, // configurable MB
    (c) => c.width * c.height * 4 // RGBA bytes
  );
  private readonly superChatGradientCache = new LruMap<string, CanvasGradient>(GRADIENT_CACHE_MAX);

  /** Cached message dimensions by message ID. Cleared on settings change. */
  private readonly dimensionCache = new Map<string, { width: number; height: number }>();

  /** Max cached dimension entries before LRU eviction. */
  private static readonly DIMENSION_CACHE_MAX = 1000;

  /**
   * Pre-allocated opacity buckets for per-frame reuse, split by speed tier.
   *
   * FAR (back) → MID (middle) → NEAR (front) z-order is enforced by
   * rendering each tier's buckets in sequence. Within each tier, bucket
   * index = Math.round(opacity × 20) yields 21 steps (0.00–1.00).
   */
  private readonly farOpacityBuckets: CanvasMessage[][] = Array.from(
    { length: OPACITY_BUCKET_COUNT },
    () => []
  );
  private readonly midOpacityBuckets: CanvasMessage[][] = Array.from(
    { length: OPACITY_BUCKET_COUNT },
    () => []
  );
  private readonly nearOpacityBuckets: CanvasMessage[][] = Array.from(
    { length: OPACITY_BUCKET_COUNT },
    () => []
  );

  /** Cached opacity config object — rebuilt on settings changes to avoid per-frame allocation. */
  private cachedOpacityConfig!: {
    baseOpacity: number;
    fadeDurationMs: number;
    invFadeDuration: number;
    backlogOpacityMultiplier: number;
    depthLayersEnabled: boolean;
    depthFarOpacityMul: number;
    ageFadeRate: number;
  };

  /** Pre-bound getFont to avoid per-call arrow function allocation. */
  private readonly boundGetFont = (fs: number): string => this.getFont(fs);
  /** Pre-bound measureTextWidth to avoid per-call arrow function allocation. */
  private readonly boundMeasureTextWidth = (text: string): number =>
    measureTextWidth(text, this.boundGetFont(this.settings.fontSize));

  /** Pre-computed exponential distribution table for stagger delay (256 entries).
   *  Each entry = -ln(1 - (i+0.5)/256), yielding a positive exponential sample.
   *  Indexed by floor(fastRandom() * 256) — avoids per-message Math.log calls. */
  private static readonly STAGGER_EXP_TABLE: Float64Array = (() => {
    const t = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
      t[i] = -Math.log(1 - (i + 0.5) / 256);
    }
    return t;
  })();

  private static readonly IDLE_GRACE_PERIOD_MS = 500;

  /** WebGL2-accelerated image rendering overlay (experimental). */
  private webgl2: WebGL2ImageRenderer | null = null;

  /**
   * H2: Tracks whether the status bar has been rendered at least once
   * since the last status change. When transitioning from idle with a
   * non-connected status, one extra frame is allowed to render the
   * status bar before stopping the render loop.
   */
  private _hasRenderedStatusBar = false;

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);
    this.invFadeDuration = computeInvFadeDuration(settings.fadeDurationMs);
    this.translationBatchSize = settings.translationBatchSize;
    this.translationService = new TranslationService();
    // Initialize language detection pipeline for 'auto' source
    this.languageDetector = new LanguageDetectorService();
    this.channelMemory = new ChannelLanguageMemory();
    void this.languageDetector.initialize().catch((err: unknown) => {
      log.debug('LanguageDetector init failed, auto-source unavailable:', err);
      // Set to null so performSourceDetection() can retry later
      this.languageDetector = null;
    });

    // Check channel memory for cached language
    const channelKey = ChannelLanguageMemory.keyFromUrl(location.href);
    const cachedSource = channelKey ? this.channelMemory.get(channelKey) : undefined;

    void this.translationService
      .configure({
        enabled: settings.translationEnabled,
        service: settings.translationService,
        source: cachedSource ?? settings.translationSource,
        target: settings.translationTarget,
      })
      .catch((err: unknown) => {
        log.debug('TranslationService configure failed:', err);
      });
    this.messageActivator = new MessageActivator(this.translationService, {
      topBottomDurationMs: settings.topBottomDurationMs,
      depthLayersEnabled: settings.depthLayersEnabled,
    });

    const container = overlay.getContainer();
    const canvas = document.createElement('canvas');
    canvas.style.cssText = CANVAS_CSS;
    canvas.setAttribute('aria-hidden', 'true');
    if (container) container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { desynchronized: true });
    if (!this.ctx) {
      log.warn('Failed to get CanvasRenderingContext2D — renderer will be inactive');
    } else if (!canvas.isConnected) {
      log.warn('Canvas created but not connected to DOM — renderer will be inactive');
    }

    // C1: Listen for Canvas 2D context restoration to recover from GPU crashes / driver resets.
    // Without this, a context loss permanently disables the renderer until page reload.
    //
    // Note: This codebase uses Canvas2D + OffscreenCanvas Worker only — there is no WebGL2
    // renderer implementation (the RenderWorkerManagerWebGL2 references in CHANGELOG.md
    // describe a prior experimental path that has been removed/restructured). Therefore no
    // webglcontextlost/webglcontextrestored listeners are needed. If a WebGL2 renderer is
    // added in the future, it must also listen for webglcontextlost and webglcontextrestored
    // with resource re-initialization (shader recompilation, buffer re-upload, texture restore).
    canvas.addEventListener('contextlost', (e: Event) => {
      e.preventDefault();
      this.ctx = null;
      log.warn('Canvas 2D context lost — renderer paused until restoration');
    });
    canvas.addEventListener('contextrestored', () => this.handleContextRestored());

    // M7: IntersectionObserver for offscreen detection. When the canvas is
    // hidden behind a modal/backdrop, pause the renderer. A recovery poll
    // guards against missed intersection entries on modal dismiss.
    this.setupOffscreenObserver(canvas);

    // Visually-hidden live region for connection status announcements
    const statusRegion = document.createElement('div');
    statusRegion.setAttribute('aria-live', 'polite');
    statusRegion.setAttribute('role', 'status');
    statusRegion.style.cssText = SCREEN_READER_CSS;
    if (container) container.appendChild(statusRegion);
    this.statusRegion = statusRegion;

    // Click handler for status bar (click-to-reload on DISCONNECTED)
    this.canvasClickHandler = (e: MouseEvent) => {
      if (this.connectionStatus !== 'disconnected') return;
      if (!this.statusBarHitRegion || !this.onStatusBarClick) return;
      const { x, y, w, h } = this.statusBarHitRegion;
      if (e.offsetX >= x && e.offsetX <= x + w && e.offsetY >= y && e.offsetY <= y + h) {
        this.onStatusBarClick();
      }
    };
    canvas.addEventListener('click', this.canvasClickHandler);

    // Note: ImageFetchManager cleanup is handled by onDestroy(), which is
    // called by RuntimeManager.disposeSession() before a new renderer is
    // created.  The old guard here never fired because the field is only
    // assigned later in this constructor (line 311).

    // Initialize WebGL2 overlay for GPU-accelerated glow effects (OffscreenCanvas).
    {
      const initDims = overlay.getDimensions();
      if (initDims) {
        this.webgl2 = new WebGL2ImageRenderer(initDims.width, initDims.height);
      }
    }

    // Initialize ImageFetchManager BEFORE RenderWorkerManager so the worker
    // receives a valid reference instead of undefined.
    this.imageFetchManager = new ImageFetchManager();

    // Initialize OffscreenCanvas worker for off-main-thread rendering.
    // Falls back silently to main-thread rendering when unavailable
    // (e.g. missing APIs, CSP restrictions, build-time exclusion).
    this.workerManager = new RenderWorkerManager({
      settings: this.settings,
      observability: this.observability,
      imageFetchManager: this.imageFetchManager,
      estimateDimensions: (msg) => this.estimateDimensions(msg),
      getMessagePriority: CanvasRenderer.getMessagePriority,
      getEffectiveSpeedPxPerSec: () => this.getEffectiveSpeedPxPerSec(),
    });
    const useWorker = this.workerManager.init(canvas, settings, overlay);

    const dims = overlay.getDimensions();
    if (!useWorker) this.applyDevicePixelRatio(dims);

    this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
      if (d && this.canvas) {
        this.applyDevicePixelRatio(d);
        this.laneAllocator.reset(d);
        this.webgl2?.resize(d.width, d.height);
      }
    });

    this.startRenderLoop();
    this.imageFetchManager.updateConfig(settings, this.workerManager.workerRef);
    this.imageFetchManager.setOnImageReady(() => {
      if (!this.isPaused && !this.isVideoPaused && !this.needsRerender) {
        if (this.animFrameId !== null) {
          this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
        }
        this.needsRerender = true;
        this.startRenderLoop();
      }
    });
    this.buildOpacityConfig();
    // Initialize prefers-reduced-motion query
    this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.reducedMotionQuery.matches;
    this.reducedMotionQuery.addEventListener('change', (e: MediaQueryListEvent) => {
      this.reducedMotion = e.matches;
    });
    log.info('RendererCanvas created');
  }

  /** Effective reduced-motion: OS preference AND-ed with user override. */
  private get isReducedMotionActive(): boolean {
    return this.reducedMotion && !this.settings.ignoreReducedMotion;
  }

  /** Total number of lanes in the allocator. */
  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  /** Get current lane utilization ratio (0–1): occupied lanes / total lanes. */
  override getLaneUtilization(): number {
    return this.laneAllocator.getUtilization();
  }

  /** Update standby status via ConnectionStatus — backward compat. */
  override setStandbyStatus(standby: boolean): void {
    this.setConnectionStatus(standby ? 'standby' : 'connected');
  }

  /** Inform the renderer of the current connection health status. */
  override setConnectionStatus(status: ConnectionStatus): void {
    if (status !== this.connectionStatus) {
      // H2: Reset status bar render flag so the idle-detection logic
      // allows one extra frame to render the new status bar before
      // potentially stopping the render loop.
      this._hasRenderedStatusBar = false;
    }
    this.connectionStatus = status;
    // Update the screen-reader live region so status changes are announced
    // even when the canvas-rendered pill is clipped or offscreen.
    if (this.statusRegion) {
      this.statusRegion.textContent = this.getStatusMessage(status);
    }
    // Enable pointer events on canvas when disconnected so click-to-reload works
    if (this.canvas) {
      this.canvas.style.pointerEvents = status === 'disconnected' ? 'auto' : 'none';
    }
    // Ensure render loop runs when status needs to be displayed (all non-CONNECTED states)
    if (status !== 'connected' && this.animFrameId === null) {
      this.startRenderLoop();
    }
  }

  /** Set replay mode and propagate to the worker. */
  override setReplayMode(enabled: boolean): void {
    super.setReplayMode(enabled);
    this.workerManager.sendReplayModeToWorker(enabled);
  }

  getQueueLength(): number {
    return this.pendingQueue.size;
  }

  override getActiveMessageCount(): number {
    return this.activeMessages.length;
  }

  override isWorkerAlive(): boolean {
    return this.workerManager.isActive ? this.workerManager.isAlive() : true;
  }

  // ── Message ingress ──────────────────────────────────────────────────

  addMessage(message: ChatMessage): void {
    if (!this.isMessageAllowed(message)) return;

    // Always enqueue through main-thread pendingQueue so lane allocation
    // and collision detection run in one place.  When the Worker is active
    // the placed message is forwarded to it for rendering after drainQueue
    // succeeds — the Worker no longer maintains its own lane allocator.
    this.enqueueMessage(message, true);

    // Pre-emptively trigger translation and forward to worker when active.
    // The worker needs translated text for rendering; we send it asynchronously
    // so it arrives before or shortly after the placed-message batch.
    if (this.workerManager.isActive) {
      const translatableText = getTranslatableText(message);
      if (this.translationService.isEnabled && translatableText) {
        const msgId = message.id ?? `${message.timestamp}-${Math.random()}`;
        this.translationService
          .translate(translatableText)
          .then((translated) => {
            this.workerManager.sendTranslation(msgId, translated);
          })
          .catch(() => {
            // Silently ignore individual translation failures
          });
      }
    }
  }

  /**
   * Replay a previously received message without observability tracking.
   * Used by replayLatestMessages so replayed messages don't inflate
   * drop-rate denominators or trigger burst detection / rate limiting.
   */
  override replayMessage(message: ChatMessage): void {
    if (this.isVideoPaused) return;
    this.enqueueMessage(message, false);
  }

  /**
   * H1: Replay messages that arrived during video pause.
   * Called from resumeForVideo() via the base class after the pause flag clears.
   * Enqueues buffered messages into the pending queue for rendering.
   */
  protected override onResumeFromVideoPause(messages: ChatMessage[]): void {
    for (const message of messages) {
      // Don't use burst detector (these messages are from the past)
      // and don't track drops (they were already counted as 'video_paused')
      this.enqueueMessage(message, false);
    }
  }

  private enqueueMessage(message: ChatMessage, trackDrops: boolean): void {
    const priority = CanvasRenderer.getMessagePriority(message);
    this.imageFetchManager.prefetchImages(message);

    const result = enqueueWithOverflow(
      this.pendingQueue,
      message,
      priority,
      (reason) => {
        if (trackDrops) this.observability.onMessageDropped(reason);
      },
      this.settings.queueMaxSize
    );
    if (result === 'dropped') return;

    this.updateBacklogPause();

    // Trigger an immediate render frame so the message appears within
    // one frame (~16ms) instead of waiting for the next natural rAF.
    // When the loop self-idled (animFrameId === null), restart it.
    // Skip if paused — the render loop would just return immediately.
    if (this.pendingQueue.size === 1 && !this.isPaused && !this.isVideoPaused) {
      if (this.animFrameId !== null) {
        this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
      }
      this.startRenderLoop();
    }
  }

  override trimBackgroundQueue(): void {
    if (this.pendingQueue.size <= this.settings.backgroundQueueMax) return;
    // Defer trimming to a background task so it doesn't compete with
    // frame-critical rendering or message processing.
    schedulerPostTask(
      () => {
        this.pendingQueue.trim(this.settings.backgroundQueueMax);
      },
      { priority: 'background' }
    );
  }

  /** Drain all pending queue messages for re-injection (used by overlay refresh). */
  override drainPendingQueue(): ChatMessage[] {
    const messages: ChatMessage[] = [];
    while (!this.pendingQueue.isEmpty) {
      const msg = this.pendingQueue.dequeue();
      if (msg) messages.push(msg);
    }
    return messages;
  }

  /** Clear all active messages (used by overlay refresh). */
  override clearActiveMessages(): void {
    this.activeMessages.length = 0;
    this.activeMessagesByLane.clear();
  }

  /** Clear pending queue (used by overlay refresh). */
  override clearPendingQueue(): void {
    this.pendingQueue.clear();
  }

  /**
   * Return a snapshot of the pending queue for burst EMA pre-warming.
   * Called by RendererBase.resume() to seed the BurstDetector EMA with
   * inter-message intervals from messages queued during the pause.
   */
  override getPendingQueueMessages(): ChatMessage[] {
    return this.pendingQueue.toArray();
  }

  /** Explicitly restart the render loop (used by overlay refresh). */
  override resumeRenderLoop(): void {
    this.idleSince = null;
    this._hasRenderedStatusBar = false;
    this.startRenderLoop();
  }

  /** Prepare renderer for a clean restart (overlay refresh). Preserves caches but clears all display state. */
  override prepareForRefresh(): void {
    this.clearActiveMessages();
    this.clearPendingQueue();
    this.workerManager.clearState();
    this.backlogPaused = false;
    this.dimensionCache.clear();
    for (const bucket of this.farOpacityBuckets) bucket.length = 0;
    for (const bucket of this.midOpacityBuckets) bucket.length = 0;
    for (const bucket of this.nearOpacityBuckets) bucket.length = 0;
    this.idleSince = null;
    this._hasRenderedStatusBar = false;
    // Reset the render activity heartbeat so the watchdog does not
    // immediately re-detect the pre-refresh stuck state.  The backlog
    // injection that follows will update this timestamp when the first
    // message is successfully placed.
    this.lastRenderActivity = performance.now();
  }

  // ── Render loop ──────────────────────────────────────────────────────

  private applyDevicePixelRatio(dims?: OverlayDimensions | null): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx || !dims) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = dims.width * dpr;
    canvas.height = dims.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lastDpr = dpr;
  }

  private startRenderLoop(): void {
    if (this.animFrameId !== null) return;
    // Reset grace period on restart — fresh cycle, no prior idle state.
    this.idleSince = null;
    const loop = (): void => {
      if (!this.canvas?.isConnected) {
        this.animFrameId = null;
        return;
      }
      this.renderFrame();
      // Stop the render loop when there is no work to do — no visible
      // messages, no queued messages. This eliminates wasted 60fps rAF
      // cycles when the stream has no chat activity.
      // The loop is restarted by:
      //   - enqueueMessage (queue 0→1 transition, running or self-idled)
      //   - setStandbyStatus(true)
      //   - setConnectionStatus (non-connected status change)
      //   - onResume (tab visibility or video unpause)
      //   - emoji/sticker load callbacks (via needsRerender flag)
      //
      // A 500ms idle grace period prevents start/stop thrashing during
      // sparse chat intervals — the loop continues briefly after the
      // idle condition is first met, so a message arriving within 500ms
      // reuses the same rAF cycle without restart overhead.
      //
      // H2: Idle detection covers ALL connection states. When idle with
      // a non-connected status, one extra frame renders the status bar
      // before stopping the loop. When the status changes, the loop is
      // restarted via setConnectionStatus.
      if (this.activeMessages.length === 0 && this.pendingQueue.isEmpty) {
        // H2: Allow one extra frame for status bar rendering when idle
        // with a non-connected status.
        if (!this._hasRenderedStatusBar && this.connectionStatus !== 'connected') {
          this._hasRenderedStatusBar = true;
        } else {
          const now = performance.now();
          if (this.idleSince === null) {
            this.idleSince = now;
          } else if (now - this.idleSince >= CanvasRenderer.IDLE_GRACE_PERIOD_MS) {
            this.animFrameId = null;
            this.idleSince = null;
            return;
          }
        }
        // Continue the loop during the grace period.
      } else {
        this.idleSince = null; // reset — not idle anymore
      }
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  private stopRenderLoop(): void {
    this.animFrameId = clearSafeAnimationFrame(this.animFrameId);
  }

  // ── Offscreen recovery (M7) ──────────────────────────────────────────

  /**
   * Set up an IntersectionObserver on the canvas to detect when it is
   * hidden (e.g. behind a settings modal/backdrop). On offscreen transition
   * the renderer is paused; a recovery poll guards against missed
   * intersection-entries when the modal is dismissed.
   */
  private setupOffscreenObserver(canvas: HTMLCanvasElement): void {
    this.offscreenObserver?.disconnect();
    this.offscreenObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (!entry.isIntersecting) {
          // Canvas is offscreen — pause and start recovery poll
          if (!this.isPaused) {
            this.pause();
          }
          this.startOffscreenPoll(canvas);
        } else {
          // Canvas is back on screen — stop poll, resume if paused
          this.stopOffscreenPoll();
          if (this.isPaused) {
            this.resume();
          }
        }
      },
      { threshold: 0 }
    );
    this.offscreenObserver.observe(canvas);
  }

  /**
   * Periodic poll (~1000ms) that checks whether the canvas has become
   * visible again. Guards against the IntersectionObserver failing to
   * fire a re-entry event when a modal/backdrop covering the canvas is
   * dismissed.
   */
  private startOffscreenPoll(canvas: HTMLCanvasElement): void {
    if (this.offscreenPollInterval !== null) return;
    this.offscreenPollInterval = setInterval(() => {
      // Check multiple visibility signals to handle edge cases
      const rect = canvas.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const isRectVisible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left < viewportW &&
        rect.top < viewportH &&
        rect.right > 0 &&
        rect.bottom > 0;
      const docVisible = document.visibilityState === 'visible';

      // Canvas is considered visible when the rect intersects the viewport
      // AND the document is visible (tab not hidden).
      if (isRectVisible && docVisible) {
        this.stopOffscreenPoll();
        if (this.isPaused) {
          this.resume();
        }
      }
    }, 1000);
  }

  private stopOffscreenPoll(): void {
    if (this.offscreenPollInterval !== null) {
      clearInterval(this.offscreenPollInterval);
      this.offscreenPollInterval = null;
    }
  }

  private renderFrame(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    if (!canvas.isConnected) return;
    if (this.isPaused) return;
    if (this.isVideoPaused) return;
    const t0 = performance.now();

    // Reset emoji-load debounce flag — any pending rAF restart has landed
    this.needsRerender = false;

    // Reuse t0 for position/opacity — the sub-microsecond difference between
    // two performance.now() calls is invisible to any rendering calculation.
    const now = t0;
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    // ── Translation drain ──
    this.applyPendingTranslations();

    // ── DPR update ──
    this.updateCanvasDpr(canvas, ctx, dims);

    // ── Clear + status bar ──
    // Always clear canvas first — prevents stale status bar from persisting
    // when connection transitions to 'connected' with no active messages.
    // Mirrors renderer-worker.ts renderFrame unconditional clearRect.
    ctx.clearRect(0, 0, dims.width, dims.height);

    const hasContent = this.activeMessages.length > 0 || this.connectionStatus !== 'connected';
    if (this.connectionStatus !== 'connected') {
      this.renderStatusBar(ctx, dims);
    }

    const mode = this.settings.danmakuMode;

    // ── Drain stage: anti-block gate + lane allocation ──
    this.drainStage(now, dims);

    this.observability.updateLaneUtilization(this.laneAllocator.getUtilization());
    this.observability.tick();

    // Early exit for empty frames — nothing to render.
    if (!hasContent) return;

    // ── Cleanup + opacity buckets (merged single pass) ──
    const cleanupResult = this.cleanupAndBucketStage(now, dims, mode);

    // Post-cleanup: compact array + clean lane map for expired messages
    if (cleanupResult.anyRemoved) {
      this.compactRemovedMessages(cleanupResult.writeIdx, cleanupResult.oldLength);
    }

    // ── Draw stage: WebGL2 glow first (under text), then Canvas2D text on top ──
    this.webgl2?.beginFrame();
    this.collectGlowInstances(cleanupResult.nearBuckets);
    const glowCanvas = this.webgl2?.flush();

    ctx.clearRect(0, 0, dims.width, dims.height);
    if (glowCanvas) {
      ctx.drawImage(glowCanvas, 0, 0, dims.width, dims.height);
    }

    this.drawStage(ctx, cleanupResult.farBuckets);
    this.drawStage(ctx, cleanupResult.midBuckets);
    this.drawStage(ctx, cleanupResult.nearBuckets);

    // ── Live region mirroring: expose last 10 visible messages to AT ──
    this.mirrorVisibleMessages();

    this.observability.recordRenderFrame(performance.now() - t0);
  }

  // ── renderFrame stages ─────────────────────────────────────────────────

  /** Apply batched translation results to active messages. */
  private applyPendingTranslations(): void {
    if (this.pendingTranslations.length === 0) return;
    const end = Math.min(
      this.pendingTranslationReadIdx + this.translationBatchSize,
      this.pendingTranslations.length
    );
    for (let i = this.pendingTranslationReadIdx; i < end; i++) {
      const entry = this.pendingTranslations[i];
      if (!entry) continue;
      entry.msg.translatedText = entry.text;
    }
    this.pendingTranslationReadIdx = end;
    if (this.pendingTranslationReadIdx >= this.pendingTranslations.length) {
      this.pendingTranslations.length = 0;
      this.pendingTranslationReadIdx = 0;
    }
  }

  /** Update canvas dimensions when device pixel ratio changes. */
  private updateCanvasDpr(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    dims: OverlayDimensions
  ): void {
    const dpr = window.devicePixelRatio || 1;
    if (dpr === this.lastDpr) return;
    this.lastDpr = dpr;
    canvas.width = dims.width * dpr;
    canvas.height = dims.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Anti-block gate + drainQueue.
   * When lane utilization is critically high, new placements are paused.
   * If anti-block persists beyond ANTI_BLOCK_MAX_DURATION_MS, drainQueue
   * is force-called to prevent indefinite message suppression.
   */
  private drainStage(now: number, _dims: OverlayDimensions): void {
    // Anti-block throttle: check BEFORE resetBatch() to avoid paying the
    // lane-allocator batch-advance cost when anti-block suppresses all
    // new placements on this frame.
    if (!this.isReplayMode && this.isAntiBlockActive()) {
      const currentNow = performance.now();
      if (this.antiBlockSince === null) {
        this.antiBlockSince = currentNow;
      }

      const front = this.pendingQueue.peek();
      const forceDrain =
        front !== undefined && currentNow - this.antiBlockSince >= ANTI_BLOCK_MAX_DURATION_MS;
      const highPriorityFront =
        front && CanvasRenderer.getMessagePriority(front) >= ANTI_BLOCK_PRIORITY_THRESHOLD;

      if (highPriorityFront || forceDrain) {
        if (forceDrain) {
          this.antiBlockSince = currentNow;
        }
        // Only call resetBatch() + drainQueue() when the anti-block gate
        // actually passes — saves lane-allocator overhead on suppressed frames.
        this.laneAllocator.resetBatch();
        this.drainQueue(now);
      }
    } else {
      this.antiBlockSince = null;
      this.laneAllocator.resetBatch();
      this.drainQueue(now);
    }
  }

  /**
   * Single-pass cleanup + opacity bucket pre-scan.
   * Removes expired messages and computes per-message opacity bucket
   * assignment. Returns buckets for the draw stage and compaction metadata.
   */
  private cleanupAndBucketStage(
    now: number,
    dims: OverlayDimensions,
    mode: string
  ): {
    farBuckets: CanvasMessage[][];
    midBuckets: CanvasMessage[][];
    nearBuckets: CanvasMessage[][];
    anyRemoved: boolean;
    writeIdx: number;
    oldLength: number;
  } {
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const farBuckets = this.farOpacityBuckets;
    const midBuckets = this.midOpacityBuckets;
    const nearBuckets = this.nearOpacityBuckets;
    for (const bucket of farBuckets) bucket.length = 0;
    for (const bucket of midBuckets) bucket.length = 0;
    for (const bucket of nearBuckets) bucket.length = 0;
    this.expiredMessagesScratch.length = 0;

    const oldLength = this.activeMessages.length;
    let writeIdx = 0;
    let anyRemoved = false;

    for (let i = 0; i < oldLength; i++) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const elapsed = now - msg.startTime - msg.pausedDuration;

      // Expired: message has exceeded its display duration
      if (elapsed >= msg.duration) {
        this.expiredMessagesScratch.push(msg);
        this.messageActivator.releaseMessage(msg);
        anyRemoved = true;
        continue;
      }

      // Keep message in active array (in-place compaction)
      this.activeMessages[writeIdx] = msg;
      writeIdx++;

      // Still in stagger delay — keep in array but skip rendering
      if (elapsed < 0) continue;

      // ── Render pre-compute ──
      // Save previous position for temporal frame blending (FAR-tier motion blur)
      if (msg.speedTier === SPEED_TIER.FAR) {
        msg._prevX = msg.x;
        msg._prevY = msg.y;
      }
      const progress = Math.min(1, Math.max(0, elapsed * msg.invDuration));

      if (mode === 'scroll') {
        if (!this.isReducedMotionActive) {
          const travelDistance = msg.startX + msg.width + this.settings.exitPaddingPx;
          msg.x = msg.startX - progress * travelDistance;
        } else {
          // Reduced motion: place message at a fixed visible position (no scrolling)
          msg.x = Math.max(0, (dims.width - msg.width) / 2);
        }
      } else if (mode === 'reverse') {
        if (!this.isReducedMotionActive) {
          const travelDistance = dims.width - msg.startX + this.settings.exitPaddingPx;
          msg.x = msg.startX + progress * travelDistance;
        } else {
          // Reduced motion: place message at a fixed visible position (no scrolling)
          msg.x = Math.max(0, (dims.width - msg.width) / 2);
        }
      }

      // Fade-in starts from fadeStartTime, independent of position timeline.
      const fadeElapsed = now - msg.fadeStartTime - msg.pausedDuration;
      const opacity = computeMessageOpacity(
        msg.message,
        fadeElapsed,
        msg.duration,
        isScrolling,
        msg.speedTier,
        this.cachedOpacityConfig
      );

      const bucketIndex = Math.min(
        OPACITY_BUCKET_COUNT - 1,
        Math.round(opacity * (OPACITY_BUCKET_COUNT - 1))
      );
      msg._frameElapsed = elapsed;
      // Route to the correct speed-tier bucket for z-order rendering
      if (msg.speedTier === SPEED_TIER.FAR) {
        farBuckets[bucketIndex]!.push(msg);
      } else if (msg.speedTier === SPEED_TIER.NEAR) {
        nearBuckets[bucketIndex]!.push(msg);
      } else {
        midBuckets[bucketIndex]!.push(msg);
      }
    }

    return { farBuckets, midBuckets, nearBuckets, anyRemoved, writeIdx, oldLength };
  }

  /** Compact the activeMessages array and clean the per-lane map after expired message removal. */
  private compactRemovedMessages(writeIdx: number, oldLength: number): void {
    // Remove only expired messages from the lane map using O(1) swap-pop
    for (const msg of this.expiredMessagesScratch) {
      const slotCount = msg.slotCount ?? 1;
      const indices = msg.laneArrayIndices;
      for (let slot = 0; slot < slotCount; slot++) {
        const lane = msg.laneIndex + slot;
        const list = this.activeMessagesByLane.get(lane);
        if (!list || list.length === 0) continue;

        const idx = indices?.[slot] ?? list.indexOf(msg);
        if (idx < 0 || idx >= list.length) continue;

        const lastMsg = list[list.length - 1]!;
        if (lastMsg !== msg) {
          list[idx] = lastMsg;
          // Update the swapped message's laneArrayIndices entry for this lane
          if (lastMsg.laneArrayIndices) {
            for (let ss = 0; ss < (lastMsg.slotCount ?? 1); ss++) {
              if (lastMsg.laneIndex + ss === lane) {
                lastMsg.laneArrayIndices[ss] = idx;
                break;
              }
            }
          }
        }
        list.pop();
        if (list.length === 0) this.activeMessagesByLane.delete(lane);
      }
    }

    // Array compaction: when >50% slots expired, allocate fresh array
    if (writeIdx < oldLength * COMPACTION_THRESHOLD_RATIO) {
      const newMessages = this.activeMessages.slice(0, writeIdx);
      this.activeMessages.length = 0;
      Array.prototype.push.apply(this.activeMessages, newMessages);
    } else {
      this.activeMessages.length = writeIdx;
    }

    // Remove lanes that now have 0 messages
    for (const [lane, msgs] of this.activeMessagesByLane) {
      if (msgs.length === 0) {
        this.activeMessagesByLane.delete(lane);
      }
    }
    this.observability.updateActiveMessages(this.activeMessages.length);
    this.observability.updateQueueDepth(this.pendingQueue.size);
  }

  /**
   * Render active messages grouped by opacity bucket.
   * Each bucket is rendered with a single ctx.globalAlpha set,
   * reducing GPU state changes by ~21× vs per-message alpha.
   */
  private drawStage(ctx: CanvasRenderingContext2D, buckets: CanvasMessage[][]): void {
    for (let bucketIndex = 0; bucketIndex < OPACITY_BUCKET_COUNT; bucketIndex++) {
      const entries = buckets[bucketIndex];
      if (!entries || entries.length === 0) continue;
      const bucketOpacity = bucketIndex / (OPACITY_BUCKET_COUNT - 1);
      ctx.globalAlpha = bucketOpacity;

      try {
        for (const msg of entries) {
          const elapsed = msg._frameElapsed!;
          const snappedX = Math.floor(msg.x);
          const snappedY = Math.floor(msg.y);

          // Temporal frame blending: render ghost at previous position for FAR-tier
          if (
            msg.speedTier === SPEED_TIER.FAR &&
            msg._prevX !== undefined &&
            msg._prevY !== undefined
          ) {
            const ghostAlpha = ctx.globalAlpha * TEMPORAL_BLEND_ALPHA;
            if (ghostAlpha > 0.001) {
              ctx.save();
              ctx.globalAlpha = ghostAlpha;
              // Re-draw the same message at the previous position.
              // Use only text segments (skip emoji fallbackText from message.text)
              // to avoid ghost rendering of "PiesP Smile" etc. alongside emoji images.
              if (msg.renderMessage) {
                const ghostFont = this.boundGetFont(this.settings.fontSize);
                ctx.font = ghostFont;
                ctx.textBaseline = 'top';
                ctx.textRendering = 'optimizeSpeed';
                ctx.fontKerning = 'none';
                const ghostColor =
                  msg.renderMessage.userColor && this.settings.preserveUserColor
                    ? msg.renderMessage.userColor
                    : (msg.renderMessage.authorType &&
                        this.settings.colors[msg.renderMessage.authorType]) ||
                      this.settings.colors.normal;
                ctx.fillStyle = ghostColor;
                // Build ghost text from text segments only — skip emoji fallbackText
                // which would appear as faint ghost text alongside emoji images.
                const ghostText = getDisplayText(msg.renderMessage.content);
                if (ghostText) {
                  ctx.fillText(
                    ghostText,
                    Math.floor(msg._prevX) + rendererLayout.paddingH,
                    Math.floor(msg._prevY) + rendererLayout.paddingV
                  );
                }
              }
              ctx.restore();
            }
          }

          const renderMessage = msg.renderMessage;

          if (msg.message.kind === 'text') {
            const isReplace = this.settings.translationMode === 'replace';
            renderRegularMessage(
              ctx,
              renderMessage,
              snappedX,
              snappedY,
              {
                fontSize: this.settings.fontSize,
                fontWeight: this.settings.fontWeight,
                fontFamily: this.settings.fontFamily,
                outlineWidthPx: this.settings.outline.widthPx,
                outlineOpacity: this.settings.outline.opacity,
                showAuthor: this.settings.showAuthor[renderMessage.authorType],
                color:
                  this.settings.preserveUserColor && renderMessage.userColor
                    ? renderMessage.userColor
                    : this.settings.colors[renderMessage.authorType],
              },
              this.textBitmapCache,
              (url: string) => this.imageFetchManager.emojiCache.get(url),
              isImageReady,
              this.imageFetchManager.authorPhotoCache,
              isImageReady,
              this.boundGetFont,
              this.boundMeasureTextWidth,
              isReplace ? msg.translatedText : undefined,
              msg.speedTier === SPEED_TIER.FAR ? '1px' : undefined
            );
          } else {
            const cardConfig =
              msg.message.kind === 'superchat' ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG;
            renderPaidCard(
              ctx,
              renderMessage,
              msg.width,
              msg.height,
              snappedX,
              snappedY,
              elapsed,
              cardConfig,
              this.settings,
              this.textBitmapCache,
              this.imageFetchManager.authorPhotoCache,
              this.imageFetchManager.stickerCache,
              this.imageFetchManager.emojiCache,
              this.boundGetFont,
              this.superChatGradientCache
            );
          }

          // Render translation in dual mode
          if (msg.translatedText && this.settings.translationMode !== 'replace') {
            const fontSize = Math.max(
              1,
              Math.round(this.settings.fontSize * TRANSLATION_FONT_SCALE)
            );
            const gap = TRANSLATION_GAP_PX;
            const transY = snappedY + msg.height - fontSize - gap;
            const transColor =
              this.settings.preserveUserColor && renderMessage.userColor
                ? renderMessage.userColor
                : (msg.message.authorType && this.settings.colors[msg.message.authorType]) ||
                  this.settings.colors.normal;
            ctx.save();
            try {
              ctx.globalAlpha = bucketOpacity * TRANSLATION_OPACITY_SCALE;
              const transFont = getFontString(fontSize, 'normal', this.settings.fontFamily);
              renderSegment(
                ctx,
                msg.translatedText,
                snappedX,
                transY,
                transColor,
                fontSize,
                this.settings.outline.widthPx,
                this.settings.outline.opacity,
                this.textBitmapCache,
                (_fs: number) => transFont
              );
            } finally {
              ctx.restore();
            }
          }
        }
      } finally {
        ctx.globalAlpha = 1;
      }
    }
  }

  /**
   * Lightweight pass over NEAR-tier messages to collect WebGL2 glow instances.
   * Does NOT render Canvas2D — only calls webgl2.addGlow() for membership cards
   * with pulsing borders.  Called before the main draw stages so glow renders
   * beneath the text layer.
   */
  private collectGlowInstances(buckets: CanvasMessage[][]): void {
    if (!this.webgl2?.isEnabled) return;

    for (let bucketIndex = 0; bucketIndex < OPACITY_BUCKET_COUNT; bucketIndex++) {
      const entries = buckets[bucketIndex];
      if (!entries || entries.length === 0) continue;
      for (const msg of entries) {
        if (!msg.message || msg.message.kind === 'text') continue;
        const renderMessage = msg.renderMessage;
        if (!renderMessage) continue;

        const cardConfig =
          renderMessage.kind === 'superchat' ? SUPERCHAT_CARD_CONFIG : MEMBERSHIP_CARD_CONFIG;

        if (cardConfig.decoration !== 'pulsingBorder') continue;
        const pb = cardConfig.pulsingBorder;
        if (!pb) continue;

        const elapsed = msg._frameElapsed ?? 0;
        const sinIndex = ((elapsed * SIN_LUT_SCALE) | 0) & 255;
        const pulse = SIN_TABLE[sinIndex]! * pb.amplitude + pb.baseAlpha;
        if (pulse > 0.01) {
          this.webgl2!.addGlow(
            Math.floor(msg.x),
            Math.floor(msg.y),
            msg.width,
            msg.height,
            `rgba(${pb.borderRgb.r},${pb.borderRgb.g},${pb.borderRgb.b},1)`,
            pulse * 0.3
          );
        }
      }
    }
  }

  /** Maximum number of snippets to mirror to the aria-live region. */
  private static readonly LIVE_REGION_MAX_MESSAGES = 10;

  /**
   * Mirror snippets from visible canvas messages to an offscreen aria-live
   * region so screen readers, find-in-page, and translation tools can
   * discover canvas-rendered text content.
   */
  private mirrorVisibleMessages(): void {
    const count = Math.min(this.activeMessages.length, CanvasRenderer.LIVE_REGION_MAX_MESSAGES);
    if (count === 0) return;
    const snippets: string[] = [];
    const start = this.activeMessages.length - count;
    for (let i = start; i < this.activeMessages.length; i++) {
      const msg = this.activeMessages[i];
      if (!msg) continue;
      const text = msg.message.text;
      if (text) snippets.push(text.slice(0, 80));
    }
    if (snippets.length > 0) {
      this.overlay.updateLiveRegion(snippets);
    }
  }

  // ── Queue drain ──────────────────────────────────────────────────────

  private drainQueue(now: number): void {
    const t0 = performance.now();
    // Cache dimensions once for the entire drain cycle — avoids repeated
    // overlay.getDimensions() calls in checkPlacement/enqueueMessageWithPlacement.
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    // ── Peek-based drain: messages stay in queue until placement succeeds ──
    // Previously, drainQueue used a dequeue→retry→refill cycle with a skip
    // limit.  When the limit was exceeded (4+ consecutive collisions in a
    // single frame), dequeued messages beyond the limit were permanently lost
    // — removed from the queue but never added to retryQueue.
    //
    // Now, we snapshot the queue via toArray(), try to place every message,
    // and only remove (removeAll) those that were successfully placed.
    // Messages that fail placement stay in the queue for the next frame.
    // This guarantees zero message loss from internal queue management.
    const candidates = this.pendingQueue.toArray();
    let batchIndex = 0;
    const committed: ChatMessage[] = [];

    for (const msg of candidates) {
      if (this.activeMessages.length >= this.settings.maxConcurrentMessages) break;

      const result = this.checkPlacement(msg, now, dims);
      if (!result.ok) {
        // Message stays in queue for retry next frame.
        // checkPlacement() already called markCollision() for feedback.
        continue;
      }

      this.enqueueMessageWithPlacement(
        msg,
        now,
        result.placement,
        batchIndex,
        result.dimensions,
        result.speedTier,
        dims
      );
      batchIndex++;
      committed.push(msg);

      // Pre-warm text bitmap cache so the render loop never pays
      // the cost of cache-miss bitmap generation during drawStage.
      if (this.settings.outline.widthPx > 0 && this.settings.outline.opacity > 0) {
        const warmColor =
          this.settings.preserveUserColor && msg.userColor
            ? msg.userColor
            : this.settings.colors[msg.authorType];
        const farSpacing = result.speedTier === SPEED_TIER.FAR ? '1px' : undefined;
        warmTextBitmapCache(
          toSharedContentSegments(msg.content),
          this.settings.fontSize,
          this.settings.fontWeight,
          this.settings.fontFamily,
          warmColor,
          this.settings.outline.widthPx,
          this.settings.outline.opacity,
          this.textBitmapCache,
          this.ctx!,
          farSpacing
        );
      }
    }

    // Atomically remove successfully placed messages from the queue.
    if (committed.length > 0) {
      this.pendingQueue.removeAll(committed);
    }

    this.observability.recordDrainQueue(performance.now() - t0);
  }

  /**
   * Async drain for burst processing outside the rAF render loop.
   *
   * Processes queued messages in chunks with scheduler.yield() between
   * chunks to avoid blocking the main thread during heavy backlog drains.
   * Uses 'user-visible' priority so it doesn't starve frame-critical work.
   *
   * Falls back to synchronous drain when called from the rAF path
   * (via drainQueue).
   */
  private async drainQueueAsync(now: number): Promise<void> {
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    const candidates = this.pendingQueue.toArray();
    let batchIndex = 0;
    const committed: ChatMessage[] = [];
    let deadline = performance.now() + 50; // 50ms budget

    for (const msg of candidates) {
      if (this.activeMessages.length >= this.settings.maxConcurrentMessages) break;

      const result = this.checkPlacement(msg, now, dims);
      if (!result.ok) continue;

      this.enqueueMessageWithPlacement(
        msg,
        now,
        result.placement,
        batchIndex,
        result.dimensions,
        result.speedTier,
        dims
      );
      batchIndex++;
      committed.push(msg);

      // Yield every 50ms to keep the main thread responsive during bursts.
      deadline = await yieldIfOverBudget(deadline);
    }

    if (committed.length > 0) {
      this.pendingQueue.removeAll(committed);
    }
  }

  /**
   * Check whether placing a new message at its target lane would cause
   * visual overlap with any currently active (visible) message.
   *
   * Returns pre-computed dimensions so callers can reuse them instead of
   * calling estimateDimensions again (avoids duplicate wrap calls for
   * 2-pass-wrapping messages like SuperChat).
   *
   * For scrolling modes, overlap occurs when a new message enters from the
   * right edge while an existing message in the same or adjacent lane has
   * not yet fully exited from the left edge. We use the actual bounding
   * boxes of active messages rather than the lane allocator's theoretical
   * available-time, which can be inaccurate after pause/resume.
   *
   * For top/bottom modes, overlap occurs when an active message in the same
   * lane has not yet expired.
   */
  private checkPlacement(
    message: ChatMessage,
    now: number,
    precomputedDims?: OverlayDimensions
  ):
    | {
        ok: true;
        placement: LanePlacement;
        dimensions: { width: number; height: number };
        speedTier: number;
      }
    | {
        ok: false;
        reason: DropReason;
      } {
    const t0 = performance.now();
    const dims = precomputedDims ?? this.overlay.getDimensions();
    if (!dims) {
      this.observability.recordCollisionCheck(performance.now() - t0);
      return { ok: false, reason: 'no_lane' };
    }

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const dimensions = this.estimateDimensions(message);
    const { height: msgHeight } = dimensions;

    // Find the target lane Y position via the allocator (without committing).
    const speedTier = this.getSpeedTier(message);
    const placement = this.laneAllocator.findPlacement(msgHeight, dims, speedTier);
    if (!placement) {
      this.observability.recordCollisionCheck(performance.now() - t0);
      return { ok: false, reason: 'no_lane' };
    }

    const newLaneY = placement.laneY + placement.verticalOffset;

    // Check active messages in the target lane and adjacent lanes (reverse/newest first).
    // Lane-scoped scan: instead of O(all activeMessages), only check messages within
    // vertical overlap range. For single-slot messages: laneIndex ± 1.
    // For multi-slot messages: laneIndex-1 through laneIndex+slotCount covers all covered lanes.
    const adjacentMessages: CanvasMessage[] = [];
    const scanEnd = placement.laneIndex + placement.slotCount;
    for (let li = placement.laneIndex - 1; li <= scanEnd; li++) {
      const laneMsgs = this.activeMessagesByLane.get(li);
      if (laneMsgs) {
        for (const m of laneMsgs) adjacentMessages.push(m);
      }
    }
    // Scan newest-first for early collision exit
    for (let i = adjacentMessages.length - 1; i >= 0; i--) {
      const active = adjacentMessages[i];
      if (!active) continue;
      const activeElapsed = now - active.startTime - active.pausedDuration;
      if (activeElapsed < 0) continue; // not yet started

      // Extent-based overlap check: active occupies [active.y, active.y + active.height],
      // new message would occupy [newLaneY, newLaneY + dimensions.height].
      // Skip if no vertical overlap between the extents.
      if (active.y + active.height <= newLaneY || active.y >= newLaneY + dimensions.height)
        continue;

      if (isScrolling) {
        // Horizontal overlap: the active message's right edge must have
        // moved past the screen's RIGHT edge (not left) before a new
        // message can enter. This allows multiple comments to share the
        // same lane simultaneously — the new one enters from the right
        // while the previous one is still visible on the left.
        //
        // The headway gap is speed-aware: when the new message is faster
        // (backlog entering real-time lane), headway scales up by the
        // speed multiplier so the slower message has more lead time,
        // preventing the faster chaser from visually crossing through.
        const headwayPx = this.computeHeadwayPx(active.width, active.speedTier, speedTier);
        const travelDistance = active.startX + active.width + this.settings.exitPaddingPx;
        const activeProgress = Math.min(1, activeElapsed * active.invDuration);
        const activeRightEdge = active.startX - activeProgress * travelDistance + active.width;

        // The new message starts at the right edge (or left for reverse).
        // Overlap if the active message's right edge is still past the
        // right edge minus headway gap.
        if (mode === 'scroll') {
          if (activeRightEdge > dims.width - headwayPx) {
            forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
              this.laneAllocator.markCollision(slotIdx);
            });
            this.observability.recordCollisionCheck(performance.now() - t0);
            return { ok: false, reason: 'collision' };
          }
        } else {
          // reverse mode: messages enter from left, travel right.
          // Speed-aware headway: when a fast backlog message enters a lane
          // with a slow reverse message, headway scales up to prevent the
          // faster chaser from catching up and visually crossing through.
          const reverseTravel = dims.width - active.startX + this.settings.exitPaddingPx;
          const activeX = active.startX + activeProgress * reverseTravel;
          if (activeX + active.width > -headwayPx) {
            forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
              this.laneAllocator.markCollision(slotIdx);
            });
            this.observability.recordCollisionCheck(performance.now() - t0);
            return { ok: false, reason: 'collision' };
          }
        }
      } else {
        // Top/bottom modes: overlap if the active message in the same lane
        // has not yet expired.
        if (activeElapsed < active.duration) {
          forEachSlot(placement.laneIndex, placement.slotCount, (slotIdx) => {
            this.laneAllocator.markCollision(slotIdx);
          });
          this.observability.recordCollisionCheck(performance.now() - t0);
          return { ok: false, reason: 'collision' };
        }
      }
    }

    return { ok: true, placement, dimensions, speedTier };
  }

  // ── Message enqueue ──────────────────────────────────────────────────

  /**
   * Enqueue a message using a pre-computed placement (from checkPlacement).
   * This avoids the double findPlacement call that caused BUG-1.
   *
   * Accepts optional pre-computed dimensions to avoid duplicate
   * estimateDimensions calls (e.g. when called from drainQueue after
   * checkPlacement already computed them).
   */
  private enqueueMessageWithPlacement(
    message: ChatMessage,
    now: number,
    placement: LanePlacement,
    batchIndex = 0,
    precomputedDimensions?: { width: number; height: number },
    precomputedSpeedTier?: number,
    precomputedDims?: OverlayDimensions
  ): void {
    const dims = precomputedDims ?? this.overlay.getDimensions();
    if (!dims) return;

    const mode = this.settings.danmakuMode;
    const { width: msgWidth, height: msgHeight } =
      precomputedDimensions ?? this.estimateDimensions(message);

    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const speedTier = precomputedSpeedTier ?? this.getSpeedTier(message);

    // Horizontal stagger: progressively offset batch messages from the
    // entry edge so they don't all enter in a vertical column. Each
    // successive batch message starts further from the entry edge,
    // spreading them horizontally and breaking the vertical "wall" effect.
    const horizontalStagger =
      isScrolling && batchIndex > 0
        ? Math.min(HORIZONTAL_STAGGER_MAX, batchIndex * HORIZONTAL_STAGGER_PER_STEP)
        : 0;

    // startX: off-screen entry position for scrolling modes,
    // horizontal center for top/bottom fixed modes.
    //   scroll  → dims.width + horizontalStagger  (right edge + stagger)
    //   reverse → -(msgWidth + horizontalStagger)    (left edge − stagger)
    //   top/bottom → center of viewport
    const startX = isScrolling
      ? mode === 'scroll'
        ? dims.width + horizontalStagger
        : -(msgWidth + horizontalStagger)
      : Math.max(0, Math.floor((dims.width - msgWidth) / 2));

    let effectiveDuration: number;
    if (isScrolling) {
      const speed = this.getSpeedForTier(speedTier);
      // Total travel distance must account for horizontal stagger to maintain
      // constant velocity — a message starting further from the entry edge
      // travels farther at the same speed, so duration adjusts proportionally.
      const totalDistance =
        mode === 'scroll'
          ? startX + msgWidth + this.settings.exitPaddingPx
          : dims.width + msgWidth + this.settings.exitPaddingPx + horizontalStagger;
      effectiveDuration =
        speed > 0
          ? computeScrollDuration(
              totalDistance,
              speed,
              this.settings.scrollDurationMinMs,
              this.settings.scrollDurationMaxMs,
              this.settings.exitPaddingPx
            )
          : this.settings.scrollDurationMinMs;
    } else {
      effectiveDuration = this.settings.topBottomDurationMs;
    }

    // Moderator and owner messages stay on screen longer.
    if (message.authorType === 'moderator' || message.authorType === 'owner') {
      effectiveDuration *= this.settings.modOwnerDurationMultiplier;
    }

    const laneY = placement.laneY + placement.verticalOffset;

    // Stagger delay: spread batch entries across time to prevent vertical
    // clumping. Computed BEFORE commitPlacement so the allocator accounts
    // for the effective visual start time, not the raw 'now' timestamp.
    //
    // When the pending queue backs up, stagger is reduced to avoid
    // compounding the delay — deep queue → zero stagger (backlog mode).
    const maxStagger =
      this.pendingQueue.size > STAGGER_QUEUE_HIGH
        ? 0
        : this.pendingQueue.size > STAGGER_QUEUE_MED
          ? this.settings.staggerMediumDelayMs
          : this.settings.staggerMaxDelayMs;
    const staggerDelay =
      batchIndex > 0 && maxStagger > 0
        ? Math.round(
            Math.min(
              maxStagger,
              Math.min(batchIndex, STAGGER_BATCH_MAX) *
                STAGGER_EXP_SCALE *
                CanvasRenderer.STAGGER_EXP_TABLE[(fastRandom() * 256) >>> 0]!
            )
          )
        : 0;

    const effectiveStartTime = now + staggerDelay;
    this.laneAllocator.commitPlacement(
      placement,
      effectiveStartTime,
      effectiveDuration,
      isScrolling ? msgWidth : undefined,
      isScrolling ? dims.width : undefined,
      speedTier
    );

    this.messageActivator.activate(
      message,
      now,
      msgWidth,
      msgHeight,
      laneY,
      {
        onActivated: (cm) => {
          this.activeMessages.push(cm);
          const slotCount = placement.slotCount;
          cm.slotCount = slotCount;
          cm.laneArrayIndices = new Array(slotCount);
          for (let slot = 0; slot < slotCount; slot++) {
            const occupiedLane = cm.laneIndex + slot;
            let laneList = this.activeMessagesByLane.get(occupiedLane);
            if (!laneList) {
              laneList = [];
              this.activeMessagesByLane.set(occupiedLane, laneList);
            }
            cm.laneArrayIndices[slot] = laneList.length;
            laneList.push(cm);
          }
        },
        onMessageRendered: () => this.observability.onMessageRendered(),
        onTranslationResult: (cm, text) => {
          this.pendingTranslations.push({ msg: cm, text });
        },
      },
      effectiveDuration,
      startX,
      placement.laneIndex,
      staggerDelay,
      speedTier
    );

    // Auto-detect source language from message samples
    if (
      this.settings.translationSource === 'auto' &&
      !this.sourceDetectionDone &&
      message.text.trim()
    ) {
      this.sourceSampleBuffer.push(message.text);
      if (this.sourceSampleBuffer.length >= CanvasRenderer.SOURCE_SAMPLE_COUNT) {
        void this.performSourceDetection();
      }
    }

    // Update render activity heartbeat — signals to the watchdog that
    // the renderer is healthy (successfully enqueuing messages).
    this.lastRenderActivity = performance.now();

    // Forward the placed message to the Worker if off-main-thread rendering
    // is active.  The message still goes through the Worker's internal
    // pipeline for now, but since the main-thread pipeline has already
    // validated the placement (lane allocation + collision check), the
    // Worker can skip its own drainQueue/checkCollision in a future phase.
    if (this.workerManager.isActive) {
      const msgId = message.id ?? `${message.timestamp}-${Math.random()}`;
      this.workerManager.sendToWorker(message, msgId);
    }
  }

  // ── Dimension estimation (delegates to shared functions) ──────────────

  private estimateDimensions(message: ChatMessage): { width: number; height: number } {
    // Check message-level cache first — same message ID means same content/kind/author.
    // Invalidated on settings change (updateSettings, resetState).
    let cached: { width: number; height: number } | undefined;
    if (message.id) {
      cached = this.dimensionCache.get(message.id);
    }

    // Pre-compute translation font metrics — used in both cache-hit and fresh paths
    // when dual translation mode is active. Translation state can change between calls,
    // so this is evaluated each time but only once per invocation.
    let transHeight = 0;
    if (
      this.settings.translationEnabled &&
      this.translationService.isActive &&
      this.settings.translationMode === 'dual'
    ) {
      const transFontSize = Math.max(
        1,
        Math.round(this.settings.fontSize * TRANSLATION_FONT_SCALE)
      );
      const transFont = getFontString(transFontSize, 'normal', this.settings.fontFamily);
      const gap = TRANSLATION_GAP_PX;
      transHeight = measureTextHeight(transFont, transFontSize) + gap;
    }

    if (cached) {
      // Translation height adjustment must be re-applied (translation state can change)
      if (transHeight > 0) {
        return { width: cached.width, height: cached.height + transHeight };
      }
      return cached;
    }

    // SuperChat rendering uses showAuthor.superChat (canvas-card-renderers.ts:82),
    // not showAuthor[authorType]. Match the rendering's key so that estimation
    // and rendering agree on whether the author section is included.
    const showAuthor =
      message.kind === 'superchat'
        ? this.settings.showAuthor.superChat
        : this.settings.showAuthor[message.authorType];
    const dims = sharedEstimateDimensions(
      message,
      this.settings.fontSize,
      showAuthor,
      this.settings.fontWeight,
      this.settings.fontFamily,
      {
        superchat: this.settings.superChatMaxBodyLines,
        membership: this.settings.membershipMaxBodyLines,
      },
      this.settings.showSuperChatAmount
    );

    if (message.id) {
      // LRU eviction on overflow
      if (this.dimensionCache.size >= CanvasRenderer.DIMENSION_CACHE_MAX) {
        const oldestKey = this.dimensionCache.keys().next().value;
        if (oldestKey !== undefined) this.dimensionCache.delete(oldestKey);
      }
      this.dimensionCache.set(message.id, dims);
    }

    // In dual translation mode, add extra height for the translation text
    // below the original content (all message kinds).
    if (transHeight > 0) {
      return { width: dims.width, height: dims.height + transHeight };
    }

    return dims;
  }

  private getFont(fontSize: number): string {
    return getFontString(fontSize, this.settings.fontWeight, this.settings.fontFamily);
  }

  /** Rebuild cached opacity config from current settings. Called on constructor and updateSettings. */
  private buildOpacityConfig(): void {
    this.cachedOpacityConfig = {
      baseOpacity: this.settings.opacity,
      fadeDurationMs: this.settings.fadeDurationMs,
      invFadeDuration: this.invFadeDuration,
      backlogOpacityMultiplier: this.settings.backlogOpacityMultiplier,
      depthLayersEnabled: this.settings.depthLayersEnabled,
      depthFarOpacityMul: this.settings.depthFarOpacityMul,
      ageFadeRate: this.ageFadeRate,
    };
  }

  /**
   * Compute the headway gap (px) between a new message and an active one
   * on the same lane, accounting for speed differences.
   *
   * When the new message is faster than the active one (higher speedTier),
   * the headway is scaled up by the backlog speed multiplier so the active
   * message has more lead time — preventing the faster chaser from catching
   * up and visually crossing through.
   *
   * Same-tier messages use the standard adaptive formula:
   *   headwayPx = clamp(msgWidth × 0.08, 16, 60)
   *
   * @param activeWidth    Width of the active message on the lane (px)
   * @param activeSpeedTier Speed tier of the active message
   * @param newSpeedTier   Speed tier of the incoming message
   * @returns Headway gap in px (always ≥ 16)
   */
  private computeHeadwayPx(
    activeWidth: number,
    activeSpeedTier: number,
    newSpeedTier: number
  ): number {
    const base = computeBaseHeadwayPx(activeWidth, this.settings.headwayGapRatio);
    // Only adjust when the new message is faster (higher tier).
    if (newSpeedTier > activeSpeedTier) {
      return Math.round(base * this.settings.backlogSpeedMultiplier);
    }
    return base;
  }

  // ── Backlog pause ────────────────────────────────────────────────────

  private getEffectiveBacklogSpeed(): number {
    const speed = this.settings.speedPxPerSec * Math.max(1, this.settings.backlogSpeedMultiplier);
    return Math.max(1, speed);
  }

  /** Compute scroll speed for a given speed tier. */
  private getSpeedForTier(tier: number): number {
    const base = this.getEffectiveSpeedPxPerSec();
    switch (tier) {
      case SPEED_TIER.FAR:
        return Math.max(30, base * this.settings.depthFarSpeedMul);
      case SPEED_TIER.NEAR:
        return base * this.settings.depthNearSpeedMul;
      case SPEED_TIER.BACKLOG:
        return this.getEffectiveBacklogSpeed();
      default:
        return base;
    }
  }

  /**
   * Compute the speed tier for a message based on settings and message properties.
   * Speed tiers: 0=Far, 1=Mid, 2=Near, 3=Backlog.
   */
  private getSpeedTier(message: ChatMessage): number {
    if (message.isBacklog) return SPEED_TIER.BACKLOG;
    if (!this.settings.depthLayersEnabled) return SPEED_TIER.MID;
    const mode = this.settings.danmakuMode;
    if (mode !== 'scroll' && mode !== 'reverse') return SPEED_TIER.MID;
    // SuperChat/Membership → Near tier
    if (message.kind === 'superchat' || message.kind === 'membership') return SPEED_TIER.NEAR;
    // Regular messages: deterministic assignment via message id hash
    const hash = hashStringForTier(message.id ?? String(message.timestamp));
    return hash < TIER_NEAR_THRESHOLD ? SPEED_TIER.NEAR : SPEED_TIER.FAR;
  }

  // hashStringForTier imported from @core/renderer-constants

  // ── Opacity ──────────────────────────────────────────────────────────

  /**
   * Compute the final rendering opacity for a message by composing the
   * user-configured opacity with fade-in/out, backlog dimming, depth layer
   * dimming, and age-based fade-out. All effects are multiplicative.
   *
   * Order of application:
   *   1. settings.opacity (base, default 0.85)
   *   2. Fade-in: linear ramp over fadeDurationMs at start (top/bottom only)
   *   3. Fade-out: linear ramp over fadeDurationMs at end (all modes)
   *   4. Backlog dimming: backlogOpacityMultiplier if isBacklog
   *   5. Far depth dimming: depthFarOpacityMul for Far tier messages
   *   6. Age fade-out: linear ramp to 0 over maxMessageAgeMs (60s)
   */

  // ── Abstract hook implementations ────────────────────────────────────

  override updateSettings(settings: OverlaySettings, options?: { resetState?: boolean }): void {
    const wasTranslationEnabled = this.settings.translationEnabled;
    const prevSource = this.settings.translationSource;
    const prevDanmakuMode = this.settings.danmakuMode;
    super.updateSettings(settings, options);

    // When settings change, cached dimensions become stale
    // (font, size, weight, family, maxBodyLines all affect dimension calculation).
    this.dimensionCache.clear();
    // Text bitmap cache also depends on font/size/color settings — clear to
    // avoid stale pre-rendered canvases being reused with the wrong style.
    this.textBitmapCache.clear();
    // Pre-compute 1/fadeDurationMs to avoid per-frame divisions in opacity calc
    this.invFadeDuration = computeInvFadeDuration(settings.fadeDurationMs);

    // Sync settings to render worker when off-main-thread mode is active
    this.workerManager.updateSettings(settings);

    // When translation is disabled, clear translated text from all active
    // messages so they revert to showing only the original text on the next frame.
    if (wasTranslationEnabled && !settings.translationEnabled) {
      for (const msg of this.activeMessages) {
        msg.translatedText = null;
      }
    }

    // Re-attempt translator creation if it previously failed due to missing
    // user activation or model download. Fire-and-forget — configure() below
    // serializes behind configurePromise so they don't race.
    this.translationService.onUserActivation();

    // Reset detection state when source changes to 'auto'
    const sourceChanged = settings.translationSource !== prevSource;
    if (sourceChanged) {
      this.sourceDetectionDone = false;
      this.sourceSampleBuffer = [];
    }

    void this.translationService
      .configure({
        enabled: settings.translationEnabled,
        service: settings.translationService,
        source: settings.translationSource,
        target: settings.translationTarget,
      })
      .catch((err: unknown) => {
        log.debug('TranslationService reconfigure failed:', err);
      });

    this.messageActivator = new MessageActivator(this.translationService, {
      topBottomDurationMs: settings.topBottomDurationMs,
      depthLayersEnabled: settings.depthLayersEnabled,
    });
    this.buildOpacityConfig();

    // M6: When danmakuMode changes, active messages retain startX computed
    // for the old mode — recompute startX, duration, and current x for all
    // active messages so they render correctly in the new mode.
    if (prevDanmakuMode !== settings.danmakuMode) {
      const dims = this.overlay.getDimensions();
      if (dims && this.activeMessages.length > 0) {
        const newIsScrolling =
          settings.danmakuMode === 'scroll' || settings.danmakuMode === 'reverse';
        const now = performance.now();
        for (const msg of this.activeMessages) {
          // Preserve current progress so messages don't jump mid-flight
          const elapsed = now - msg.startTime - msg.pausedDuration;
          const oldProgress =
            msg.duration > 0 ? Math.min(1, Math.max(0, elapsed / msg.duration)) : 0;

          // Recompute startX for the new mode
          if (newIsScrolling) {
            msg.startX = settings.danmakuMode === 'scroll' ? dims.width : -(msg.width + 0); // no stagger for in-flight messages
          } else {
            msg.startX = Math.max(0, Math.floor((dims.width - msg.width) / 2));
          }

          // Recompute duration based on new mode
          if (newIsScrolling) {
            const totalDistance =
              settings.danmakuMode === 'scroll'
                ? msg.startX + msg.width + settings.exitPaddingPx
                : dims.width + msg.width + settings.exitPaddingPx;
            const speed = this.getEffectiveSpeedPxPerSec();
            msg.duration =
              speed > 0
                ? computeScrollDuration(
                    totalDistance,
                    speed,
                    settings.scrollDurationMinMs,
                    settings.scrollDurationMaxMs,
                    settings.exitPaddingPx
                  )
                : settings.scrollDurationMinMs;
          } else {
            msg.duration = settings.topBottomDurationMs;
          }
          msg.invDuration = msg.duration > 0 ? 1 / msg.duration : 0;

          // Reposition x based on new startX and preserved progress
          if (newIsScrolling) {
            if (settings.danmakuMode === 'scroll') {
              const travelDistance = msg.startX + msg.width + settings.exitPaddingPx;
              msg.x = msg.startX - oldProgress * travelDistance;
            } else {
              const reverseTravel = dims.width - msg.startX + settings.exitPaddingPx;
              msg.x = msg.startX + oldProgress * reverseTravel;
            }
          } else {
            // top/bottom: static centered
            msg.x = msg.startX;
          }
        }
      }
    }
  }

  override setChatPanelOpen(open: boolean): void {
    log.debug(`Chat panel ${open ? 'opened' : 'closed'}`);
  }

  protected onPause(): void {
    this.stopRenderLoop();
    this.workerManager.setPaused(true);
    this.imageFetchManager.pause();
  }

  protected onResume(): void {
    this.startRenderLoop();
    this.laneAllocator.resetBatch();
    // Use async drain for non-rAF context — allows yielding during
    // backlog processing to keep the main thread responsive.
    void this.drainQueueAsync(performance.now());
    this.workerManager.setPaused(false);
    this.imageFetchManager.resume();
  }

  /**
   * B-1: Per-message paused duration clamping.
   *
   * Instead of blindly adding the full paused duration (which can push
   * already-expired messages beyond their display window), each message
   * gets at most its remaining display time + 1s grace window. Messages
   * that would already be expired by now are left to expire naturally on
   * the next render frame via the merged cleanup pass.
   */
  protected override applyPausedDuration(pausedMs: number): void {
    const now = performance.now();
    for (const msg of this.activeMessages) {
      const elapsedBeforePause = now - pausedMs - msg.startTime;
      const remainingDisplay = msg.duration - elapsedBeforePause;
      // Clamp per-message: never push pausedDuration beyond what the
      // message could have possibly displayed. 1s grace prevents
      // messages from expiring mid-flight on the first post-resume frame.
      const capped = Math.max(0, Math.min(pausedMs, Math.max(0, remainingDisplay) + 1000));
      msg.pausedDuration += capped;
    }
  }

  protected resetState(): void {
    this.activeMessages.length = 0;
    this.activeMessagesByLane.clear();
    this.pendingQueue.clear();
    this.backlogPaused = false;
    this.onBacklogPauseChange = null;
    clearTextMeasurementCaches();
    this.textBitmapCache.clear();
    this.dimensionCache.clear();
  }

  private async performSourceDetection(): Promise<void> {
    if (!this.languageDetector) return;
    try {
      const detected = await this.languageDetector.detectFromSamples(this.sourceSampleBuffer);
      if (detected) {
        const channelKey = ChannelLanguageMemory.keyFromUrl(location.href);
        if (channelKey && this.channelMemory) {
          this.channelMemory.set(channelKey, detected);
        }
        await this.translationService.setDetectedSource(detected);
      }
    } catch (err: unknown) {
      log.debug('Source detection failed:', err);
    }
    this.sourceDetectionDone = true;
    this.sourceSampleBuffer = [];
  }

  protected onDestroy(): void {
    this.stopRenderLoop();
    this.workerManager.destroy();
    this.imageFetchManager.destroy();
    this.webgl2?.destroy();
    this.overlayDimensionsUnsubscribe?.();
    if (this.canvas && this.canvasClickHandler) {
      this.canvas.removeEventListener('click', this.canvasClickHandler);
    }
    this.canvasClickHandler = null;
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.imageFetchManager.emojiCache.clear();
    this.imageFetchManager.emojiFetching.clear();
    this.imageFetchManager.emojiFetchingStarted.clear();
    this.imageFetchManager.authorPhotoCache.clear();
    this.imageFetchManager.stickerCache.clear();
    this.textBitmapCache.clear();
    this.superChatGradientCache.clear();
    this.dimensionCache.clear();
    this.activeMessagesByLane.clear();
    this.pendingTranslations.length = 0;
    this.onBacklogPauseChange = null;
    this.onStatusBarClick = null;
    this.translationService.destroy();
    this.languageDetector?.destroy();
    this.languageDetector = null;
    this.channelMemory?.clear();
    this.channelMemory = null;
    // M7: Clean up offscreen observer and recovery poll
    this.stopOffscreenPoll();
    this.offscreenObserver?.disconnect();
    this.offscreenObserver = null;
    clearTextMeasurementCaches();
  }

  // ── Worker recovery / fallback ──────────────────────────────────────────

  /**
   * Replace the current canvas with a new one and acquire a fresh 2D context.
   * Used when the original canvas is unrecoverable (transferred to a dead
   * OffscreenCanvas after GPU reset or Worker crash).
   *
   * The new canvas is inserted at the same DOM position and inherits the
   * CSS size of the original. Returns true if successful.
   */
  private replaceCanvas(): boolean {
    const container = this.overlay.getContainer();
    if (!container || !this.canvas) return false;

    this.canvas.remove();

    const newCanvas = document.createElement('canvas');
    const dims = this.overlay.getDimensions();
    if (dims) {
      newCanvas.style.width = `${dims.width}px`;
      newCanvas.style.height = `${dims.height}px`;
      const dpr = window.devicePixelRatio || 1;
      newCanvas.width = dims.width * dpr;
      newCanvas.height = dims.height * dpr;
    }
    newCanvas.style.cssText = CANVAS_CSS;
    newCanvas.setAttribute('aria-hidden', 'true');
    container.appendChild(newCanvas);

    const ctx = newCanvas.getContext('2d', { desynchronized: true });
    if (!ctx) return false;

    newCanvas.addEventListener('contextlost', (e: Event) => {
      e.preventDefault();
      this.ctx = null;
      log.warn('Canvas 2D context lost — renderer paused until restoration');
    });
    newCanvas.addEventListener('contextrestored', () => this.handleContextRestored());

    this.canvas = newCanvas;
    this.ctx = ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    log.info('Canvas replaced — fallback to main-thread rendering');
    return true;
  }

  /**
   * Gracefully degrade from Worker-mode to main-thread rendering.
   * Called when the Worker is unrecoverable (dead or canvas context lost).
   */
  override fallbackToMainThread(reason: string): void {
    log.warn(`Falling back to main-thread renderer: ${reason}`);

    this.workerManager.destroy();
    this.workerManager.setActive(false);

    if (!this.replaceCanvas()) {
      log.error('Fallback failed: could not replace canvas');
      return;
    }

    this.activeMessages.length = 0;
    this.activeMessagesByLane.clear();
    this.pendingQueue.clear();
    this.backlogPaused = false;
    clearTextMeasurementCaches();
    this.textBitmapCache.clear();
    this.dimensionCache.clear();
    for (const bucket of this.farOpacityBuckets) bucket.length = 0;
    for (const bucket of this.midOpacityBuckets) bucket.length = 0;
    for (const bucket of this.nearOpacityBuckets) bucket.length = 0;

    const dims = this.overlay.getDimensions();
    if (dims) {
      this.laneAllocator.reset(dims);
    }
    this.laneAllocator.resetBatch();

    this.idleSince = null;
    this.startRenderLoop();

    log.info('Fallback to main-thread renderer complete');
  }

  // ── Canvas context loss / restoration ───────────────────────────────────

  /**
   * C1: Handle canvas context restoration after GPU crash / driver reset.
   * Re-acquires the 2D context and resumes rendering. Without this listener,
   * context loss permanently disables the renderer until page reload.
   */
  private handleContextRestored(): void {
    if (!this.canvas) return;

    // When the canvas was transferred to OffscreenCanvas (Worker mode),
    // getContext('2d') will always return null — control was permanently
    // transferred. Fall back to main-thread rendering with a fresh canvas.
    if (this.workerManager.isActive) {
      log.warn('Context restored while in Worker mode — falling back to main-thread renderer');
      this.fallbackToMainThread('gpu-reset-worker');
      return;
    }

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      log.warn('Context restored but getContext failed — renderer remains inactive');
      return;
    }
    this.ctx = ctx;
    // Restore DPR transform that was lost with the context
    const dpr = window.devicePixelRatio || 1;
    const dims = this.overlay?.getDimensions();
    if (dims) {
      this.lastDpr = dpr;
      this.canvas.width = dims.width * dpr;
      this.canvas.height = dims.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    log.info('Canvas context restored — renderer resuming');
    // Restart the render loop if it was stopped
    if (!this.isPaused && !this.isVideoPaused) {
      this.startRenderLoop();
    }
  }

  // ── Status bar rendering ────────────────────────────────────────────────

  private renderStatusBar(
    ctx: CanvasRenderingContext2D,
    dims: { width: number; height: number }
  ): void {
    const status = this.connectionStatus;
    if (status === 'connected') {
      // CONNECTED: only a small dot, subtle
      this.renderStatusDot(ctx, dims);
      return;
    }

    // All other states: pill with dot + text
    const colors = statusBarLayout.colors[status];
    const message = this.getStatusMessage(status);

    const { fontSize, paddingX, paddingY, bottomOffset, pillRadius, dotRadius, dotGap } =
      statusBarLayout;
    const font = getFontString(fontSize, 'normal', this.settings.fontFamily);
    ctx.save();
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left'; // dot + text layout

    const textWidth = ctx.measureText(message).width;
    const dotTotalWidth = dotRadius * 2 + dotGap;
    const boxW = dotTotalWidth + textWidth + paddingX * 2;
    const boxH = fontSize * 1.5 + paddingY * 2;
    const boxX = (dims.width - boxW) / 2;
    const boxY = dims.height - boxH - bottomOffset;

    // Pill background
    ctx.fillStyle = colors.bg;
    drawRoundRect(ctx, boxX, boxY, boxW, boxH, pillRadius);
    ctx.fill();

    // Status dot
    const dotX = boxX + paddingX + dotRadius;
    const dotY = boxY + boxH / 2;
    ctx.fillStyle = colors.dot;
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
    ctx.fill();

    // Text
    ctx.fillStyle = colors.text;
    ctx.fillText(message, dotX + dotRadius + dotGap, boxY + boxH / 2);

    // Store hit region for click-to-reload in DISCONNECTED state
    this.statusBarHitRegion = { x: boxX, y: boxY, w: boxW, h: boxH };

    ctx.restore();
  }

  /** Renders only a small colored dot for CONNECTED state. */
  private renderStatusDot(
    ctx: CanvasRenderingContext2D,
    dims: { width: number; height: number }
  ): void {
    const { dotRadius, bottomOffset, fontSize, paddingY } = statusBarLayout;
    const colors = statusBarLayout.colors.connected;
    const boxH = fontSize * 1.5 + paddingY * 2;
    const x = dims.width / 2;
    const y = dims.height - boxH - bottomOffset + boxH / 2;

    ctx.save();
    ctx.fillStyle = colors.dot;
    ctx.globalAlpha = DISCONNECTED_DOT_ALPHA; // subtle when connected
    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private getStatusMessage(status: ConnectionStatus): string {
    switch (status) {
      case 'connecting':
        return 'Connecting\u2026';
      case 'degraded':
        return 'Connection unstable';
      case 'disconnected':
        return 'Disconnected \u2014 Click to reload';
      case 'standby':
        return 'Waiting for live stream\u2026';
      default:
        return '';
    }
  }
}
