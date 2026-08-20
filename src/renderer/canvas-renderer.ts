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

import type { Overlay } from '@app/overlay';
import type {
  AccessibleChatMessage,
  ChatMessage,
  DropReason,
  OverlayDimensions,
  OverlaySettings,
} from '@app-types';
import { getTranslatableText } from '@chat/message-helpers';
import { t } from '@i18n/index';
import { ImageFetchManager } from '@media/image-fetch-manager';
import {
  applyDevicePixelRatio,
  disconnectObserver,
  setupOffscreenObserver,
  startOffscreenPoll,
  updateCanvasDpr,
} from '@renderer/canvas/canvas-setup';
import {
  commitDrainBatch,
  createDrainBatch,
  type DrainBatch,
  recordDrainResult,
} from '@renderer/canvas/drain-batch';
import { addMessageToLaneIndex, fastRandom } from '@renderer/canvas/pipeline-utils';
import {
  type CanvasRenderContext,
  cleanupAndBucketStage,
  compactRemovedMessages,
  drainStage,
  drawGlowStage,
  drawStage,
  mirrorVisibleMessages,
} from '@renderer/canvas/render-pipeline';
import {
  drawRoundRect,
  getDisplayText,
  toSharedContentSegments,
  warmTextBitmapCache,
} from '@renderer/canvas/shared';
import { getSpeedTier } from '@renderer/canvas/speed-tier';
import { desaturateColor } from '@renderer/color-utils';
import {
  type CanvasMessage,
  FAR_LAYER_DESATURATION_FACTOR,
  GRADIENT_CACHE_MAX,
  IDLE_GRACE_PERIOD_MS,
  OPACITY_BUCKET_COUNT,
  SPEED_TIER,
} from '@renderer/constants';
import type { LanePlacement } from '@renderer/layout/lane-allocator';
import { computeRequiredEntryHeadwayPx } from '@renderer/layout/lane-shared';
import { computeMessageMotionPlan } from '@renderer/layout/message-schedule';
import type { ConnectionStatus } from '@renderer/renderer-base';
import { RendererBase } from '@renderer/renderer-base';
import {
  computeAgeFadeRate,
  computeInvFadeDuration,
  enqueueWithOverflow,
  estimateTranslatedMessageDimensions,
  estimateMessageDimensions as sharedEstimateDimensions,
} from '@renderer/shared';
import {
  clearTextMeasurementCaches,
  getFontString,
  measureTextWidth,
} from '@renderer/text-measure';
import { RenderWorkerManager } from '@renderer/worker/manager';
import { ChannelLanguageMemory } from '@translation/channel-memory';
import { LanguageDetectorService } from '@translation/language-detector';
import { TranslationService } from '@translation/service';
import { ResizableByteLimitedCache } from '@util/byte-limited-cache';
import { DensityIndicator } from '@util/density-indicator';
import { computeScrollDuration, statusBarLayout } from '@util/design-tokens';
import { clearSafeAnimationFrame, forEachSlot, SCREEN_READER_CSS } from '@util/dom';
import { createLogger } from '@util/logging';
import { MapCompatibleLruMap } from '@util/lru-map';
import { MessageActivator } from '@util/message-activator';
import { HighFirstPriorityBucketQueue } from '@util/priority-bucket-queue';
import { scheduleOverlayTask, yieldAtDeadline } from '@util/scheduler-utils';

const log = createLogger('RendererCanvas');

/** Shared CSS string applied to all canvas elements — ensures consistent sizing and event delegation. */
const CANVAS_CSS =
  'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;text-rendering:optimizeSpeed';

/** Alpha for the connected status dot — subtle when connected. */
const DISCONNECTED_DOT_ALPHA = 0.15;

/** Shared fallback message ID counter for deterministic message ID generation
 *  when the YouTube API does not provide an id (avoids Math.random() which
 *  makes rendering non-deterministic). */
let fallbackMessageIdCounter = 0;

export class CanvasRenderer extends RendererBase {
  private canvas: HTMLCanvasElement | null = null;
  private statusActionButton: HTMLButtonElement | null = null;
  /** Set to true during onDestroy() — checked after async awaits in drainQueueAsync. */
  private _destroyed = false;
  /** Prevent concurrent Worker recovery attempts from replacing the canvas twice. */
  private fallbackInProgress = false;
  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  /** Pre-computed 1/fadeDurationMs — corrected in constructor from settings. */
  private invFadeDuration = 0;
  private overlayDimensionsUnsubscribe: (() => void) | null = null;
  private overlayUserPauseUnsubscribe: (() => void) | null = null;
  /** Density indicator for high-chat feedback. */
  private readonly densityIndicator = new DensityIndicator();
  /** Debounce flag for emoji-load-triggered rAF restarts. */
  private needsRerender = false;
  /** Image fetch manager for loading and caching emoji, author photos, and stickers. */
  private imageFetchManager!: ImageFetchManager;

  private readonly activeMessages: CanvasMessage[] = [];
  /** Lane-indexed active messages for O(1) lane-scoped collision checks. */
  private readonly activeMessagesByLane = new Map<number, CanvasMessage[]>();
  private readonly pendingQueue = new HighFirstPriorityBucketQueue();

  /** Cached prefers-reduced-motion media query result. */
  private reducedMotionQuery: MediaQueryList | null = null;
  private reducedMotion = false;
  /** Bound listener for reduced-motion changes — stored for cleanup in onDestroy. */
  private reducedMotionListener: ((e: MediaQueryListEvent) => void) | null = null;

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
  private antiBlockSinceRef = { value: null as number | null };
  /** Offscreen recovery poll cleanup function. startOffscreenPoll returns a
   *  cleanup callback, not a setInterval handle. */
  private offscreenPollCleanup: (() => void) | null = null;
  /** IntersectionObserver for detecting canvas offscreen state. */
  private offscreenObserver: IntersectionObserver | null = null;
  /** Current connection health status for overlay feedback. */
  private connectionStatus: ConnectionStatus = 'connected';
  /** Visually-hidden live region for connection status announcements. */
  private statusRegion: HTMLDivElement | null = null;
  private translationService: TranslationService;
  private messageActivator: MessageActivator;
  private languageDetector: LanguageDetectorService | null = null;
  private channelMemory: ChannelLanguageMemory | null = null;
  private sourceDetectionDone = false;
  private sourceSampleBuffer: string[] = [];
  private sourceDetectionRun: symbol | null = null;
  private sourceDetectionGeneration = 0;
  private static readonly SOURCE_SAMPLE_COUNT = 8;

  /** Max translations to apply per frame to avoid single-frame spikes during chat bursts. */
  private translationBatchSize: number;

  /**
   * Pending translation results collected between frames.
   * Promise callbacks push here; renderFrame() applies up to
   * translationBatchSize per frame, leaving the rest for
   * subsequent frames to avoid frame spikes during chat bursts.
   */
  private pendingTranslations: Array<{ msg: CanvasMessage; text: string | null }> = [];
  /** Read index for incremental pendingTranslations drain (avoids splice allocation). */
  private pendingTranslationReadIdx = 0;
  /** Invalidates in-flight translation callbacks when their configuration changes. */
  private translationConfigurationGeneration = 0;

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
  private readonly textBitmapCache = new ResizableByteLimitedCache<HTMLCanvasElement>(
    this.settings.textCacheMb * 1_000_000, // configurable MB
    (c) => c.width * c.height * 4 // RGBA bytes
  );
  private readonly superChatGradientCache = new MapCompatibleLruMap<string, CanvasGradient>(
    GRADIENT_CACHE_MAX
  );

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
  private readonly regularRenderConfig = {
    showAuthor: true,
    fontSize: 1,
    fontWeight: 'bold',
    fontFamily: '',
    color: '',
    outlineWidthPx: 0,
    outlineOpacity: 0,
    backgroundColor: '#00000000',
    messageWidth: 0,
    messageHeight: 0,
  };
  private renderContext: CanvasRenderContext | null = null;
  private readonly boundIsAntiBlockActive = (): boolean => this.isAntiBlockActive();
  private readonly boundDrainQueue = (now: number): void => this.drainQueue(now);
  private readonly boundUpdateLiveRegion = (messages: AccessibleChatMessage[]): void =>
    this.overlay.updateLiveRegion(messages);

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

  /**
   * H2: Tracks whether the status bar has been rendered at least once
   * since the last status change. When transitioning from idle with a
   * non-connected status, one extra frame is allowed to render the
   * status bar before stopping the render loop.
   */
  private hasRenderedStatusBar = false;

  /** Last timestamp when updateLiveRegion was called, for throttling. */
  private lastLiveRegionUpdateRef = { value: 0 };

  constructor(overlay: Overlay, settings: OverlaySettings) {
    super(overlay, settings);
    this.invFadeDuration = computeInvFadeDuration(settings.fadeDurationMs);
    this.translationBatchSize = settings.translationBatchSize;
    this.translationService = new TranslationService();
    if (settings.translationEnabled) {
      this.initializeSourceDetectionPipeline();
    }

    // Check channel memory for cached language
    const channelKey = ChannelLanguageMemory.resolveKey(location.href, document);
    const cachedSource = channelKey ? this.channelMemory?.get(channelKey) : undefined;

    void this.translationService
      .configure({
        enabled: settings.translationEnabled,
        service: settings.translationService,
        source: cachedSource ?? settings.translationSource,
        target: settings.translationTarget,
      })
      .catch((err: unknown) => {
        log.debug('renderer.translation.configure-failed', {
          error: String(err),
        });
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

    // Wire density indicator into the overlay container
    if (container) {
      this.densityIndicator.create(container);
    }

    // ── Phase 1: setup that does NOT depend on canvas context ──────
    //
    // IntersectionObserver for offscreen detection. When the canvas is
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

    if (container) {
      const colors = statusBarLayout.colors.disconnected;
      const statusActionButton = document.createElement('button');
      statusActionButton.id = 'yt-chat-overlay-status-action';
      statusActionButton.type = 'button';
      statusActionButton.style.cssText =
        `position:absolute;left:50%;bottom:${statusBarLayout.bottomOffset}px;` +
        'transform:translateX(-50%);display:none;align-items:center;pointer-events:auto;' +
        `z-index:1;cursor:pointer;border:0;border-radius:${statusBarLayout.pillRadius}px;` +
        `padding:${statusBarLayout.paddingY}px ${statusBarLayout.paddingX}px;` +
        `background:${colors.bg};color:${colors.text};` +
        `font-size:${statusBarLayout.fontSize}px;line-height:1.5`;
      // Keep the configurable family inside one CSS property even if a caller
      // bypasses settings normalization.
      statusActionButton.style.fontFamily = this.settings.fontFamily;
      statusActionButton.addEventListener('click', () => {
        if (this.connectionStatus === 'disconnected') this.onStatusBarClick?.();
      });
      container.appendChild(statusActionButton);
      this.statusActionButton = statusActionButton;
    }

    // Note: ImageFetchManager cleanup is handled by onDestroy(), which is
    // called by RuntimeManager.disposeSession() before a new renderer is
    // created.  The old guard here never fired because the field is only
    // assigned later in this constructor (line 311).

    // Initialize ImageFetchManager BEFORE RenderWorkerManager so the worker
    // receives a valid reference instead of undefined.
    this.imageFetchManager = new ImageFetchManager();

    // ── Phase 2: attempt OffscreenCanvas worker ────────────────────
    //
    // transferControlToOffscreen() requires the canvas to NOT have a
    // rendering context yet (HTML spec §4.12.5).  We must NOT call
    // getContext('2d') before this point, otherwise the transfer always
    // throws InvalidStateError and the renderer silently falls back to
    // the main thread every time.
    this.workerManager = new RenderWorkerManager({
      settings: this.settings,
      observability: this.observability,
      imageFetchManager: this.imageFetchManager,
      estimateDimensions: (msg) => this.estimateDimensions(msg),
      getMessagePriority: CanvasRenderer.getMessagePriority,
      getEffectiveSpeedPxPerSec: () => this.getEffectiveSpeedPxPerSec(),
    });
    this.workerManager.setFatalErrorCallback((reason) => this.fallbackToMainThread(reason));
    const workerInit = this.workerManager.init(canvas, settings, overlay);
    const useWorker = workerInit.started;

    if (!useWorker && workerInit.canvasTransferred && !this.replaceCanvas()) {
      log.warn('renderer.canvas.transfer-recovery-failed', {
        reason: 'could-not-replace-transferred-canvas',
      });
    }

    // Wire the Worker's live-region text snippets to the overlay's
    // aria-live region so screen readers can access chat content when
    // rendering via the Worker path.
    if (useWorker) {
      this.workerManager.setLiveRegionCallback((snippets) => overlay.updateLiveRegion(snippets));
    }

    // ── Phase 3: main-thread fallback setup (only when Worker failed) ──

    const dims = overlay.getDimensions();
    if (!useWorker) {
      const fallbackCanvas = this.canvas;
      if (!workerInit.canvasTransferred && fallbackCanvas) {
        this.ctx = fallbackCanvas.getContext('2d', { desynchronized: true });
      }
      if (!this.ctx || !fallbackCanvas) {
        log.warn('renderer.canvas.get-context-failed', {
          reason: 'no-2d-context',
        });
      } else if (!fallbackCanvas.isConnected) {
        log.warn('renderer.canvas.not-connected', {
          reason: 'not-in-dom',
        });
      }

      // C1: Listen for Canvas 2D context restoration to recover from GPU
      // crashes / driver resets.  Without this, a context loss permanently
      // disables the renderer until page reload.
      //
      // Note: This codebase uses Canvas2D + OffscreenCanvas Worker only —
      // there is no WebGL2 renderer implementation.  If a WebGL2 renderer
      // is added in the future, it must also listen for
      // webglcontextlost/webglcontextrestored with resource re-initialization
      // (shader recompilation, buffer re-upload, texture restore).
      if (!workerInit.canvasTransferred && fallbackCanvas) {
        fallbackCanvas.addEventListener('contextlost', (e: Event) => {
          e.preventDefault();
          this.ctx = null;
          log.warn('renderer.canvas.context-lost', {
            reason: 'initial-create',
          });
        });
        fallbackCanvas.addEventListener('contextrestored', () => this.handleContextRestored());

        this.applyDevicePixelRatio(dims);
      }
    }

    this.overlayDimensionsUnsubscribe = overlay.onDimensionsChanged((d) => {
      // Paid-card width bounds depend on the current viewport width.
      // Queued messages must be remeasured after every resize.
      this.dimensionCache.clear();
      if (d && this.canvas) {
        this.applyDevicePixelRatio(d);
        this.laneAllocator.reset(d);
        this.reflowActiveMessages(d);
      }
    });

    // Forward user-pause toggle to both main-thread and worker renderers
    this.overlayUserPauseUnsubscribe = overlay.onUserPauseChanged((paused) => {
      this.setUserPaused(paused);
      if (this.workerManager.isActive) {
        this.workerManager.setUserPaused(paused);
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
    this.reducedMotionListener = (e: MediaQueryListEvent) => {
      this.reducedMotion = e.matches;
      // Relay OS preference change to the Worker (workers lack matchMedia).
      if (this.workerManager.isActive) {
        this.workerManager.sendReducedMotion(e.matches as boolean);
      }
    };
    this.reducedMotionQuery.addEventListener('change', this.reducedMotionListener);

    log.info('renderer.created', {
      mode: 'canvas2d',
    });
  }

  /** Reflow visible messages and restore lane reservations after a resize. */
  private reflowActiveMessages(dimensions: OverlayDimensions): void {
    const laneCount = this.laneAllocator.getLaneCount();
    const laneHeight = this.laneAllocator.getLaneHeight();
    if (laneCount <= 0 || laneHeight <= 0) return;

    const now = performance.now();
    const isScrolling =
      this.settings.danmakuMode === 'scroll' || this.settings.danmakuMode === 'reverse';
    this.activeMessagesByLane.clear();

    for (const message of this.activeMessages) {
      const requestedSlots = Math.max(1, Math.ceil(message.height / laneHeight));
      const slotCount = Math.min(requestedSlots, laneCount);
      const laneIndex = Math.min(message.laneIndex, Math.max(0, laneCount - slotCount));
      message.laneIndex = laneIndex;
      message.slotCount = slotCount;
      message.y =
        this.laneAllocator.getLaneY(laneIndex, dimensions.height) +
        Math.floor((slotCount * laneHeight - message.height) / 2);
      message.laneArrayIndices.length = 0;

      const elapsed = Math.max(0, now - message.startTime - message.pausedDuration);
      const progress = Math.min(1, elapsed * message.invDuration);
      if (isScrolling) {
        if (this.settings.danmakuMode === 'scroll') {
          message.startX = dimensions.width;
          message.x =
            message.startX -
            progress * (message.startX + message.width + this.settings.exitPaddingPx);
        } else {
          message.startX = -message.width;
          message.x =
            message.startX +
            progress * (dimensions.width - message.startX + this.settings.exitPaddingPx);
        }
      } else {
        message.x = (dimensions.width - message.width) / 2;
      }

      addMessageToLaneIndex(this.activeMessagesByLane, message, slotCount);

      const remainingDuration = Math.max(1, message.duration - elapsed);
      this.laneAllocator.commitPlacement(
        {
          laneIndex,
          waitMs: 0,
          laneY: this.laneAllocator.getLaneY(laneIndex, dimensions.height),
          slotCount,
          verticalOffset: 0,
        },
        now,
        remainingDuration,
        isScrolling ? message.width : undefined,
        isScrolling ? dimensions.width : undefined,
        message.speedTier
      );
    }
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
      this.hasRenderedStatusBar = false;
    }
    this.connectionStatus = status;
    // Update the screen-reader live region so status changes are announced
    // even when the canvas-rendered pill is clipped or offscreen.
    if (this.statusRegion) {
      this.statusRegion.textContent = this.getStatusMessage(status);
    }
    // Keep the full-size canvas non-interactive. Only the dedicated status
    // action button should receive pointer events while disconnected.
    if (this.canvas) {
      this.canvas.style.pointerEvents = 'none';
    }
    if (this.statusActionButton) {
      const isDisconnected = status === 'disconnected';
      const statusMessage = this.getStatusMessage(status);
      this.statusActionButton.style.display = isDisconnected ? 'flex' : 'none';
      this.statusActionButton.textContent = statusMessage;
      this.statusActionButton.setAttribute('aria-label', statusMessage);
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
    return this.pendingQueue.size + this.workerManager.queueDepth;
  }

  override getActiveMessageCount(): number {
    return this.activeMessages.length + this.workerManager.activeMessageCount;
  }

  override isWorkerAlive(): boolean {
    return this.workerManager.isActive ? this.workerManager.isAlive() : true;
  }

  /** Override to relay lane density changes to the Worker renderer. */
  protected override applyLaneDensityIfChanged(): boolean {
    const changed = super.applyLaneDensityIfChanged();
    if (changed && this.workerManager.isActive) {
      this.workerManager.sendLaneDensity(this.currentLaneDensityFactor);
    } else if (changed) {
      const dimensions = this.overlay.getDimensions();
      if (dimensions) this.reflowActiveMessages(dimensions);
    }
    return changed;
  }

  // ── Message ingress ──────────────────────────────────────────────────

  addMessage(message: ChatMessage): void {
    if (message.actionType === 'replace' && message.id) {
      if (this.workerManager.isActive) {
        if (this.workerManager.sendToWorker(message, message.id)) {
          this.prefetchAndTranslateForWorker(message, message.id);
        }
        this.lastRenderActivity = performance.now();
        return;
      }
      if (this.replaceMainThreadMessage(message)) return;
    }

    if (!this.isMessageAllowed(message)) return;

    // When the Worker owns the OffscreenCanvas, forward the message
    // directly and skip main-thread queue/lane management entirely.
    // The Worker has its own complete render pipeline: pending queue,
    // lane heap, collision detection, anti-block logic, and draw.
    if (this.workerManager.isActive) {
      const msgId = message.id ?? `${message.timestamp}-${++fallbackMessageIdCounter}`;
      if (this.workerManager.sendToWorker(message, msgId)) {
        this.prefetchAndTranslateForWorker(message, msgId);
      }
      this.lastRenderActivity = performance.now();

      return;
    }

    // ── Main-thread fallback path ──────────────────────────────────
    //
    // Enqueue through main-thread pendingQueue so lane allocation and
    // collision detection run during renderFrame.  The placed message
    // is drawn by the main-thread canvas pipeline.
    this.enqueueMessage(message, true);
  }

  /** Upsert a same-ID replacement already owned by the main-thread renderer. */
  private replaceMainThreadMessage(message: ChatMessage): boolean {
    const id = message.id;
    if (!id) return false;

    const pending = this.pendingQueue.toArray().find((entry) => entry.id === id);
    if (pending) {
      this.pendingQueue.removeAll([pending]);
      this.dimensionCache.delete(id);
      this.enqueueMessage(message, false);
      return true;
    }

    const active = this.activeMessages.find((entry) => entry.message.id === id);
    if (!active) return false;

    this.dimensionCache.delete(id);
    this.imageFetchManager.prefetchImages(message);
    this.collectSourceLanguageSample(message);
    this.pendingTranslations = this.pendingTranslations
      .slice(this.pendingTranslationReadIdx)
      .filter((entry) => entry.msg !== active);
    this.pendingTranslationReadIdx = 0;

    active.message = message;
    active.renderMessage = message;
    active.ghostText = getDisplayText(message.content);
    active.translatedText = null;
    delete active.translatedRenderMessage;
    delete active.translationHeight;

    if (
      this.settings.depthLayersEnabled &&
      active.speedTier === SPEED_TIER.FAR &&
      message.userColor
    ) {
      active.desaturatedUserColor = desaturateColor(
        message.userColor,
        FAR_LAYER_DESATURATION_FACTOR
      );
      active.renderMessage = { ...message, userColor: active.desaturatedUserColor };
    } else {
      delete active.desaturatedUserColor;
    }

    const geometry = this.estimateTranslatedDimensions(message, null);
    const geometryChanged = this.applyMessageGeometry(active, geometry);
    this.requestReplacementTranslation(active, message);
    if (geometryChanged) {
      const dimensions = this.overlay.getDimensions();
      if (dimensions) {
        this.laneAllocator.reset(dimensions);
        this.reflowActiveMessages(dimensions);
      }
    }
    this.lastRenderActivity = performance.now();
    this.resumeRenderLoop();
    return true;
  }

  /** Translate an active replacement while rejecting stale same-ID results. */
  private requestReplacementTranslation(active: CanvasMessage, message: ChatMessage): void {
    const translatableText = getTranslatableText(message);
    if (!this.translationService.isEnabled || !translatableText) return;
    const generation = this.translationConfigurationGeneration;
    this.translationService
      .translate(translatableText)
      .then((translated) => {
        if (active.message === message) {
          this.queueTranslationResult(active, translated, generation);
        }
      })
      .catch(() => {
        // Silently ignore individual translation failures.
      });
  }

  /**
   * Replay a previously received message without observability tracking.
   * Used by replayLatestMessages so replayed messages don't inflate
   * drop-rate denominators or trigger burst detection / rate limiting.
   */
  override replayMessage(message: ChatMessage): void {
    if (this.isVideoPaused) return;
    if (this.workerManager.isActive) {
      const msgId = message.id ?? `${message.timestamp}-${++fallbackMessageIdCounter}`;
      if (this.workerManager.sendToWorker(message, msgId)) {
        this.prefetchAndTranslateForWorker(message, msgId);
      }
      return;
    }
    this.enqueueMessage(message, false);
  }

  /**
   * H1: Replay messages that arrived during video pause.
   * Called from resumeForVideo() via the base class after the pause flag clears.
   * Enqueues buffered messages into the pending queue for rendering.
   */
  protected override onResumeFromVideoPause(messages: ChatMessage[]): void {
    for (const message of messages) {
      if (this.workerManager.isActive) {
        const msgId = message.id ?? `${message.timestamp}-${++fallbackMessageIdCounter}`;
        if (this.workerManager.sendToWorker(message, msgId)) {
          this.prefetchAndTranslateForWorker(message, msgId);
        }
      } else {
        this.enqueueMessage(message, false);
      }
    }
  }

  private enqueueMessage(message: ChatMessage, trackDrops: boolean): void {
    const priority = CanvasRenderer.getMessagePriority(message);

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
    this.imageFetchManager.prefetchImages(message);

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
    scheduleOverlayTask(
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
    this.hasRenderedStatusBar = false;
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
    this.hasRenderedStatusBar = false;
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
    this.lastDpr = applyDevicePixelRatio(canvas, ctx, dims);
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
        if (!this.hasRenderedStatusBar && this.connectionStatus !== 'connected') {
          this.hasRenderedStatusBar = true;
        } else {
          const now = performance.now();
          if (this.idleSince === null) {
            this.idleSince = now;
          } else if (now - this.idleSince >= IDLE_GRACE_PERIOD_MS) {
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
    this.stopOffscreenPoll();
    this.offscreenObserver = setupOffscreenObserver(
      canvas,
      () => {
        // Canvas is offscreen — pause and start recovery poll
        if (!this.isPaused) {
          this.pause();
        }
        this.startOffscreenPoll(canvas);
      },
      () => {
        // Canvas is back on screen — stop poll, resume if paused.
        // Guard against resuming while the tab is still hidden (rare race
        // with IntersectionObserver firing during tab transitions).
        this.stopOffscreenPoll();
        if (this.isPaused && document.visibilityState !== 'hidden') {
          this.resume();
        }
      }
    );
  }

  /**
   * Periodic poll (~1000ms) that checks whether the canvas has become
   * visible again. Guards against the IntersectionObserver failing to
   * fire a re-entry event when a modal/backdrop covering the canvas is
   * dismissed.
   */
  private startOffscreenPoll(canvas: HTMLCanvasElement): void {
    if (this.offscreenPollCleanup !== null) return;
    this.offscreenPollCleanup = startOffscreenPoll(canvas, () => {
      if (this.isPaused && document.visibilityState !== 'hidden') {
        this.resume();
      }
    });
  }

  private stopOffscreenPoll(): void {
    if (this.offscreenPollCleanup !== null) {
      this.offscreenPollCleanup();
      this.offscreenPollCleanup = null;
    }
  }

  private renderFrame(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    if (!canvas.isConnected) return;
    if (this.isPaused) return;
    if (this.isVideoPaused) return;
    if (this.isUserPaused) return;
    // Burst-driven lane density also controls the Worker allocator, so update
    // it before the main-thread canvas path exits for OffscreenCanvas mode.
    this.applyLaneDensityIfChanged();
    // When Worker mode is active (OffscreenCanvas transferred to worker),
    // the main-thread ctx is still a non-null reference but is detached.
    // Canvas operations on a detached context would throw silently.
    if (this.workerManager.isActive) return;
    const t0 = performance.now();

    // Reset emoji-load debounce flag — any pending rAF restart has landed
    this.needsRerender = false;

    // Reuse t0 for position/opacity — the sub-microsecond difference between
    // two performance.now() calls is invisible to any rendering calculation.
    const now = t0;
    const dims = this.overlay.getDimensions();
    if (!dims) return;

    // ── Build render context ──
    const rctx = this.buildRenderContext();

    // ── Translation drain ──
    this.applyPendingTranslations();

    // ── DPR update ──
    this.updateCanvasDpr(canvas, ctx, dims);

    // ── Clear + status bar ──
    // Always clear canvas first — prevents stale status bar from persisting
    // when connection transitions to 'connected' with no active messages.
    // Mirrors the Worker renderFrame unconditional clearRect.
    ctx.clearRect(0, 0, dims.width, dims.height);

    if (this.connectionStatus !== 'connected') {
      this.renderStatusBar(ctx, dims);
    }

    const mode = this.settings.danmakuMode;

    // ── Drain stage: anti-block gate + lane allocation ──
    drainStage(rctx, now, dims);

    this.observability.updateLaneUtilization(this.laneAllocator.getUtilization());
    this.observability.tick();

    // Update density indicator based on active message count
    this.densityIndicator.update(this.activeMessages.length, this.settings.maxConcurrentMessages);

    // Evaluate after draining so a message activated on an idle frame is
    // positioned and drawn without an avoidable extra-rAF delay.
    const hasContent = this.activeMessages.length > 0 || this.connectionStatus !== 'connected';
    if (!hasContent) return;

    // ── Cleanup + opacity buckets (merged single pass) ──
    const cleanupResult = cleanupAndBucketStage(rctx, now, dims, mode);

    // Post-cleanup: compact array + clean lane map for expired messages
    if (cleanupResult.anyRemoved) {
      compactRemovedMessages(rctx, cleanupResult.writeIdx, cleanupResult.oldLength);
    }

    // ── Glow stage: membership card pulsing borders ──
    // Drive glow by cardConfig.decoration over all buckets, not just nearBuckets,
    // so pulsing-border glow works even when depth layers are disabled.
    drawGlowStage(rctx, ctx, cleanupResult.farBuckets);
    drawGlowStage(rctx, ctx, cleanupResult.midBuckets);
    drawGlowStage(rctx, ctx, cleanupResult.nearBuckets);

    drawStage(rctx, ctx, cleanupResult.farBuckets);
    drawStage(rctx, ctx, cleanupResult.midBuckets);
    drawStage(rctx, ctx, cleanupResult.nearBuckets);

    // ── Live region mirroring: expose last 10 visible messages to AT ──
    mirrorVisibleMessages(rctx);

    this.observability.recordRenderFrame(performance.now() - t0);
  }

  /**
   * Build a CanvasRenderContext from the current instance state.
   * Called once per frame to share references with pipeline functions.
   * The context is a lightweight object with references — no allocations
   * of complex data structures.
   */
  private buildRenderContext(): CanvasRenderContext {
    if (this.renderContext) {
      this.renderContext.settings = this.settings;
      this.renderContext.messageActivator = this.messageActivator;
      this.renderContext.cachedOpacityConfig = this.cachedOpacityConfig;
      this.renderContext.isReplayMode = this.isReplayMode;
      this.renderContext.isReducedMotionActive = this.isReducedMotionActive;
      return this.renderContext;
    }

    this.renderContext = {
      settings: this.settings,
      textBitmapCache: this.textBitmapCache,
      superChatGradientCache: this.superChatGradientCache,
      imageFetchManager: this.imageFetchManager,
      boundGetFont: this.boundGetFont,
      boundMeasureTextWidth: this.boundMeasureTextWidth,
      regularRenderConfig: this.regularRenderConfig,
      activeMessages: this.activeMessages,
      activeMessagesByLane: this.activeMessagesByLane,
      farOpacityBuckets: this.farOpacityBuckets,
      midOpacityBuckets: this.midOpacityBuckets,
      nearOpacityBuckets: this.nearOpacityBuckets,
      expiredMessagesScratch: this.expiredMessagesScratch,
      messageActivator: this.messageActivator,
      cachedOpacityConfig: this.cachedOpacityConfig,
      antiBlockSince: this.antiBlockSinceRef,
      pendingQueue: this.pendingQueue,
      laneAllocator: this.laneAllocator,
      observability: this.observability,
      isReplayMode: this.isReplayMode,
      isReducedMotionActive: this.isReducedMotionActive,
      isAntiBlockActive: this.boundIsAntiBlockActive,
      drainQueue: this.boundDrainQueue,
      lastLiveRegionUpdate: this.lastLiveRegionUpdateRef,
      updateLiveRegion: this.boundUpdateLiveRegion,
    };
    return this.renderContext;
  }

  // ── renderFrame stages ─────────────────────────────────────────────────

  /** Apply batched translation results to active messages. */
  private applyPendingTranslations(): void {
    if (this.pendingTranslations.length === 0) return;
    let geometryChanged = false;
    const end = Math.min(
      this.pendingTranslationReadIdx + this.translationBatchSize,
      this.pendingTranslations.length
    );
    for (let i = this.pendingTranslationReadIdx; i < end; i++) {
      const entry = this.pendingTranslations[i];
      if (!entry) continue;
      entry.msg.translatedText = entry.text;
      if (entry.text) {
        entry.msg.translatedRenderMessage = {
          ...entry.msg.renderMessage,
          text: entry.text,
          content: [{ type: 'text', content: entry.text }],
        };
      } else {
        delete entry.msg.translatedRenderMessage;
      }
      const geometry = this.estimateTranslatedDimensions(entry.msg.message, entry.text);
      geometryChanged = this.applyMessageGeometry(entry.msg, geometry) || geometryChanged;
    }
    this.pendingTranslationReadIdx = end;
    if (this.pendingTranslationReadIdx >= this.pendingTranslations.length) {
      this.pendingTranslations.length = 0;
      this.pendingTranslationReadIdx = 0;
    } else if (this.pendingTranslationReadIdx > 0) {
      // Compact: shift consumed entries out so the array doesn't grow unbounded
      // when translations arrive faster than translationBatchSize per frame.
      this.pendingTranslations.splice(0, this.pendingTranslationReadIdx);
      this.pendingTranslationReadIdx = 0;
    }
    if (geometryChanged) {
      const dimensions = this.overlay.getDimensions();
      if (dimensions) {
        this.laneAllocator.reset(dimensions);
        this.reflowActiveMessages(dimensions);
      }
    }
  }

  /** Update dimensions while preserving the current scrolling position and speed. */
  private applyMessageGeometry(
    message: CanvasMessage,
    geometry: { width: number; height: number; translationHeight: number }
  ): boolean {
    const changed = message.width !== geometry.width || message.height !== geometry.height;
    if (changed) {
      const dimensions = this.overlay.getDimensions();
      const isScrolling =
        this.settings.danmakuMode === 'scroll' || this.settings.danmakuMode === 'reverse';
      if (dimensions && isScrolling) {
        const now = performance.now();
        const speed = this.getSpeedForTier(message.speedTier);
        const totalDistance = dimensions.width + geometry.width + this.settings.exitPaddingPx;
        let duration = computeScrollDuration(
          totalDistance,
          speed,
          this.settings.scrollDurationMinMs,
          this.settings.scrollDurationMaxMs,
          this.settings.exitPaddingPx
        );
        if (message.message.authorType === 'moderator' || message.message.authorType === 'owner') {
          duration *= this.settings.modOwnerDurationMultiplier;
        }
        const progress =
          this.settings.danmakuMode === 'scroll'
            ? (dimensions.width - message.x) / Math.max(1, totalDistance)
            : (message.x + geometry.width) / Math.max(1, totalDistance);
        message.duration = duration;
        message.invDuration = 1 / Math.max(1, duration);
        message.startTime =
          now - message.pausedDuration - Math.max(0, Math.min(1, progress)) * duration;
      }
      message.width = geometry.width;
      message.height = geometry.height;
    }
    message.translationHeight = geometry.translationHeight;
    return changed;
  }

  private queueTranslationResult(
    msg: CanvasMessage,
    text: string | null,
    generation: number
  ): void {
    if (
      generation !== this.translationConfigurationGeneration ||
      !this.settings.translationEnabled
    ) {
      return;
    }
    this.pendingTranslations.push({ msg, text });
  }

  /** Update canvas dimensions when device pixel ratio changes. */
  private updateCanvasDpr(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    dims: OverlayDimensions
  ): void {
    this.lastDpr = updateCanvasDpr(canvas, ctx, dims, this.lastDpr);
  }

  /**
   * Anti-block gate + drainQueue.
   * When lane utilization is critically high, new placements are paused.
   * If anti-block persists beyond ANTI_BLOCK_MAX_DURATION_MS, drainQueue
   * is force-called to prevent indefinite message suppression.
   */
  // ── renderFrame stages ─────────────────────────────────────────────────

  /** Try one queued message and warm its text bitmap when placement succeeds. */
  private placeQueuedMessage(
    message: ChatMessage,
    now: number,
    dimensions: OverlayDimensions,
    batchIndex: number,
    previousStaggerDelayMs: number
  ): { placed: boolean; oversized: boolean; staggerDelayMs?: number } {
    const result = this.checkPlacement(
      message,
      now,
      dimensions,
      batchIndex,
      previousStaggerDelayMs
    );
    if (!result.ok) {
      return { placed: false, oversized: result.reason === 'oversized' };
    }

    const staggerDelayMs = this.enqueueMessageWithPlacement(
      message,
      now,
      result.placement,
      batchIndex,
      previousStaggerDelayMs,
      result.dimensions,
      result.speedTier,
      dimensions
    );

    if (
      this.settings.outline.enabled &&
      this.settings.outline.widthPx > 0 &&
      this.settings.outline.opacity > 0
    ) {
      const warmColor =
        this.settings.preserveUserColor && message.userColor
          ? message.userColor
          : (this.settings.colors[message.authorType] ?? this.settings.colors.normal);
      const farSpacing = result.speedTier === SPEED_TIER.FAR ? '1px' : undefined;
      warmTextBitmapCache(
        toSharedContentSegments(message.content),
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

    return { placed: true, oversized: false, staggerDelayMs };
  }

  private drainQueue(now: number): void {
    if (this.drainLocked) return;
    this.drainLocked = true;
    try {
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
      const batch = createDrainBatch(this.pendingQueue.toArray());

      for (const msg of batch.candidates) {
        if (this.activeMessages.length >= this.settings.maxConcurrentMessages) break;

        const result = this.placeQueuedMessage(
          msg,
          now,
          dims,
          batch.batchIndex,
          batch.staggerCursorMs
        );
        recordDrainResult(batch, msg, result);
      }

      this.finalizeDrainBatch(batch, true);

      this.observability.recordDrainQueue(performance.now() - t0);
    } finally {
      this.drainLocked = false;
    }
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
    if (this.drainLocked) return;
    this.drainLocked = true;
    try {
      const dims = this.overlay.getDimensions();
      if (!dims) return;

      const batch = createDrainBatch(this.pendingQueue.toArray());
      let deadline = performance.now() + 50; // 50ms budget

      for (const msg of batch.candidates) {
        if (this.activeMessages.length >= this.settings.maxConcurrentMessages) break;

        const currentDims = this.overlay.getDimensions();
        if (!currentDims) break;
        const placementNow = Math.max(now, performance.now());

        const result = this.placeQueuedMessage(
          msg,
          placementNow,
          currentDims,
          batch.batchIndex,
          batch.staggerCursorMs
        );
        recordDrainResult(batch, msg, result);

        // Check the budget after every attempt, including collision failures,
        // so an unplaceable backlog cannot monopolize the main thread.
        deadline = await yieldAtDeadline(deadline);

        // Session may have been destroyed during the yield — abort drain
        // to avoid accessing null canvas/ctx or injecting messages into
        // a disposed renderer.
        if (this._destroyed) return;
      }

      this.finalizeDrainBatch(batch, false);
    } finally {
      this.drainLocked = false;
    }
  }

  private finalizeDrainBatch(batch: DrainBatch<ChatMessage>, reportOversized: boolean): void {
    commitDrainBatch(this.pendingQueue, batch);
    if (batch.unplaceable.length === 0) return;

    // Update render activity so the watchdog doesn't flag a stuck renderer
    // for messages that were intentionally dropped as oversized.
    this.lastRenderActivity = performance.now();
    if (!reportOversized) return;

    const first = batch.unplaceable[0]!;
    const firstEstHeight = Math.round(this.estimateDimensions(first).height);
    const laneCount = this.laneAllocator.getLaneCount();
    const requiredSlots = Math.ceil(
      firstEstHeight / Math.round(this.laneAllocator.getLaneHeight())
    );
    log.warn('renderer.message.drop', {
      reason: 'oversized',
      dropped: batch.unplaceable.length,
      requiredSlots,
      laneCount,
      sampleKind: first.kind,
    });
    this.observability.onMessageDropped('oversized');
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
    precomputedDims?: OverlayDimensions,
    batchIndex = 0,
    previousStaggerDelayMs = 0
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
      return { ok: false, reason: 'temporarily_unavailable' };
    }

    const mode = this.settings.danmakuMode;
    const isScrolling = mode === 'scroll' || mode === 'reverse';
    const dimensions = this.estimateDimensions(message);
    const { height: msgHeight } = dimensions;

    // Classify unplaceable messages:
    //   - If requiredSlots > totalLanes → message is genuinely too tall, drop permanently.
    //   - Otherwise → transient lane saturation (all lanes colliding, speed-tier
    //     incompatibility, or wait-timeout); keep in queue for retry next frame.
    const totalLanes = this.laneAllocator.getLaneCount();
    const laneHeight = this.laneAllocator.getLaneHeight();
    const requiredSlots = Math.max(1, Math.ceil(msgHeight / laneHeight));
    if (requiredSlots > totalLanes) {
      this.observability.recordCollisionCheck(performance.now() - t0);
      return { ok: false, reason: 'oversized' };
    }

    // Find the target lane Y position via the allocator (without committing).
    const speedTier = this.getSpeedTier(message);
    const laneStrategy = mode === 'top' ? 'top' : mode === 'bottom' ? 'bottom' : 'spread';
    const placement = this.laneAllocator.findPlacement(
      msgHeight,
      dims,
      speedTier,
      now,
      laneStrategy
    );
    if (!placement) {
      this.observability.recordCollisionCheck(performance.now() - t0);
      return { ok: false, reason: 'temporarily_unavailable' };
    }

    const durationMultiplier =
      message.authorType === 'moderator' || message.authorType === 'owner'
        ? this.settings.modOwnerDurationMultiplier
        : 1;
    const incomingMotion = computeMessageMotionPlan({
      mode,
      now,
      batchIndex,
      previousStaggerDelayMs,
      queueDepth: this.pendingQueue.size,
      staggerSample: 0,
      maxStaggerDelayMs: this.settings.staggerMaxDelayMs,
      mediumStaggerDelayMs: this.settings.staggerMediumDelayMs,
      placementWaitMs: placement.waitMs,
      screenWidth: dims.width,
      messageWidth: dimensions.width,
      velocityPxPerSec: this.getSpeedForTier(speedTier),
      scrollDurationMinMs: this.settings.scrollDurationMinMs,
      scrollDurationMaxMs: this.settings.scrollDurationMaxMs,
      exitPaddingPx: this.settings.exitPaddingPx,
      topBottomDurationMs: this.settings.topBottomDurationMs,
      durationMultiplier,
    });

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
        const travelDistance = active.startX + active.width + this.settings.exitPaddingPx;
        const activeTravelDistance =
          mode === 'scroll'
            ? travelDistance
            : dims.width - active.startX + this.settings.exitPaddingPx;
        const headwayPx = computeRequiredEntryHeadwayPx({
          activeWidthPx: active.width,
          headwayGapRatio: this.settings.headwayGapRatio,
          activeTravelDistancePx: activeTravelDistance,
          activeDurationMs: active.duration,
          activeElapsedMs: activeElapsed,
          incomingTravelDistancePx: incomingMotion.travelDistancePx,
          incomingDurationMs: incomingMotion.durationMs,
        });
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
          // Collision: the active message's LEFT edge must have cleared
          // the left-side entry zone (+ headway gap) before a new message
          // can enter the same lane. Testing the RIGHT edge (as the old
          // code did) was always true — blocking lane reuse entirely.
          const reverseTravel = dims.width - active.startX + this.settings.exitPaddingPx;
          const activeX = active.startX + activeProgress * reverseTravel;
          if (activeX < headwayPx) {
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
    previousStaggerDelayMs = 0,
    precomputedDimensions?: { width: number; height: number },
    precomputedSpeedTier?: number,
    precomputedDims?: OverlayDimensions
  ): number {
    const dims = precomputedDims ?? this.overlay.getDimensions();
    if (!dims) return previousStaggerDelayMs;

    const mode = this.settings.danmakuMode;
    const { width: msgWidth, height: msgHeight } =
      precomputedDimensions ?? this.estimateDimensions(message);

    const speedTier = precomputedSpeedTier ?? this.getSpeedTier(message);

    const laneY = placement.laneY + placement.verticalOffset;
    const durationMultiplier =
      message.authorType === 'moderator' || message.authorType === 'owner'
        ? this.settings.modOwnerDurationMultiplier
        : 1;
    const motion = computeMessageMotionPlan({
      mode,
      now,
      batchIndex,
      previousStaggerDelayMs,
      queueDepth: this.pendingQueue.size,
      staggerSample: CanvasRenderer.STAGGER_EXP_TABLE[(fastRandom() * 256) >>> 0]!,
      maxStaggerDelayMs: this.settings.staggerMaxDelayMs,
      mediumStaggerDelayMs: this.settings.staggerMediumDelayMs,
      placementWaitMs: placement.waitMs,
      screenWidth: dims.width,
      messageWidth: msgWidth,
      velocityPxPerSec: this.getSpeedForTier(speedTier),
      scrollDurationMinMs: this.settings.scrollDurationMinMs,
      scrollDurationMaxMs: this.settings.scrollDurationMaxMs,
      exitPaddingPx: this.settings.exitPaddingPx,
      topBottomDurationMs: this.settings.topBottomDurationMs,
      durationMultiplier,
    });
    this.laneAllocator.commitPlacement(
      placement,
      motion.startTime,
      motion.durationMs,
      motion.isScrolling ? msgWidth : undefined,
      motion.isScrolling ? dims.width : undefined,
      speedTier,
      motion.horizontalStaggerPx
    );

    const translationGeneration = this.translationConfigurationGeneration;
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
          addMessageToLaneIndex(this.activeMessagesByLane, cm, slotCount);
        },
        onMessageRendered: () => this.observability.onMessageRendered(),
        onTranslationResult: (cm, text) => {
          this.queueTranslationResult(cm, text, translationGeneration);
        },
      },
      motion.durationMs,
      motion.startX,
      placement.laneIndex,
      motion.startTime - now,
      speedTier
    );

    this.collectSourceLanguageSample(message);

    // Update render activity heartbeat — signals to the watchdog that
    // the renderer is healthy (successfully enqueuing messages).
    this.lastRenderActivity = performance.now();
    return motion.staggerDelayMs;
  }

  // ── Dimension estimation (delegates to shared functions) ──────────────

  private estimateDimensions(message: ChatMessage): { width: number; height: number } {
    // Check message-level cache first — same message ID means same content/kind/author.
    // Invalidated on settings change (updateSettings, resetState).
    let cached: { width: number; height: number } | undefined;
    if (message.id) {
      cached = this.dimensionCache.get(message.id);
    }

    if (cached) return cached;

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
      this.settings.showSuperChatAmount,
      this.getSpeedTier(message) === SPEED_TIER.FAR ? '1px' : '0px',
      this.settings.outline.enabled ? this.settings.outline.widthPx : 0,
      this.overlay.getDimensions()?.width
    );

    if (message.id) {
      // LRU eviction on overflow
      if (this.dimensionCache.size >= CanvasRenderer.DIMENSION_CACHE_MAX) {
        const oldestKey = this.dimensionCache.keys().next().value;
        if (oldestKey !== undefined) this.dimensionCache.delete(oldestKey);
      }
      this.dimensionCache.set(message.id, dims);
    }

    return dims;
  }

  private estimateTranslatedDimensions(
    message: ChatMessage,
    translatedText: string | null
  ): { width: number; height: number; translationHeight: number } {
    const showAuthor =
      message.kind === 'superchat'
        ? this.settings.showAuthor.superChat
        : this.settings.showAuthor[message.authorType];
    const availableWidth = this.overlay.getDimensions()?.width;
    return estimateTranslatedMessageDimensions(
      message,
      translatedText,
      this.settings.translationMode,
      {
        fontSize: this.settings.fontSize,
        showAuthor,
        fontWeight: this.settings.fontWeight,
        fontFamily: this.settings.fontFamily,
        maxBodyLines: {
          superchat: this.settings.superChatMaxBodyLines,
          membership: this.settings.membershipMaxBodyLines,
        },
        showSuperChatAmount: this.settings.showSuperChatAmount,
        letterSpacing: this.getSpeedTier(message) === SPEED_TIER.FAR ? '1px' : '0px',
        outlineWidthPx: this.settings.outline.enabled ? this.settings.outline.widthPx : 0,
        ...(availableWidth !== undefined ? { availableWidth } : {}),
      }
    );
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
      ageFadeRate: computeAgeFadeRate(this.settings.maxMessageAgeMs),
    };
  }

  // ── Backlog pause ────────────────────────────────────────────────────

  /**
   * Prefetch images and trigger translation for a message destined for the
   * worker renderer.  Shared by addMessage, replayMessage, and
   * onResumeFromVideoPause so replayed and video-unpaused messages receive
   * the same pre-processing as live messages.
   */
  private prefetchAndTranslateForWorker(message: ChatMessage, msgId: string): void {
    this.imageFetchManager.prefetchImages(message);
    this.collectSourceLanguageSample(message);
    const translatableText = getTranslatableText(message);
    if (this.translationService.isEnabled && translatableText) {
      this.translationService
        .translate(translatableText)
        .then((translated) => {
          if (!this.workerManager.isCurrentMessage(msgId, message)) return;
          this.workerManager.sendTranslation(
            msgId,
            translated,
            this.estimateTranslatedDimensions(message, translated)
          );
        })
        .catch(() => {
          // Silently ignore individual translation failures
        });
    }
  }

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
   * Delegates to the pure {@link getSpeedTier} function in {@link @renderer/canvas/speed-tier}.
   */
  private getSpeedTier(message: ChatMessage): number {
    return getSpeedTier(message, {
      depthLayersEnabled: this.settings.depthLayersEnabled,
      danmakuMode: this.settings.danmakuMode,
    });
  }

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
    const translationConfigurationChanged =
      settings.translationEnabled !== this.settings.translationEnabled ||
      settings.translationService !== this.settings.translationService ||
      settings.translationSource !== this.settings.translationSource ||
      settings.translationTarget !== this.settings.translationTarget ||
      settings.translationMode !== this.settings.translationMode;
    const laneGeometryChanged =
      settings.fontSize !== this.settings.fontSize ||
      settings.fontWeight !== this.settings.fontWeight ||
      settings.fontFamily !== this.settings.fontFamily ||
      settings.laneSpacing !== this.settings.laneSpacing ||
      settings.safeTop !== this.settings.safeTop ||
      settings.safeBottom !== this.settings.safeBottom;
    super.updateSettings(settings, options);
    this.translationBatchSize = settings.translationBatchSize;
    if (translationConfigurationChanged) {
      this.translationConfigurationGeneration++;
      this.pendingTranslations.length = 0;
      this.pendingTranslationReadIdx = 0;
    }

    // When settings change, cached dimensions become stale
    // (font, size, weight, family, maxBodyLines all affect dimension calculation).
    this.dimensionCache.clear();
    // Text bitmap cache also depends on font/size/color settings — clear to
    // avoid stale pre-rendered canvases being reused with the wrong style.
    this.textBitmapCache.resize(settings.textCacheMb * 1_000_000);
    this.textBitmapCache.clear();
    // Pre-compute 1/fadeDurationMs to avoid per-frame divisions in opacity calc
    this.invFadeDuration = computeInvFadeDuration(settings.fadeDurationMs);

    // Sync settings to render worker when off-main-thread mode is active
    this.workerManager.updateSettings(settings);
    this.imageFetchManager.updateConfig(settings, this.workerManager.workerRef);

    // When translation is disabled, clear translated text from all active
    // messages and restore the original card geometry on both render paths.
    let translationGeometryChanged = false;
    if (wasTranslationEnabled && !settings.translationEnabled) {
      for (const msg of this.activeMessages) {
        msg.translatedText = null;
        delete msg.translatedRenderMessage;
        translationGeometryChanged =
          this.applyMessageGeometry(msg, this.estimateTranslatedDimensions(msg.message, null)) ||
          translationGeometryChanged;
      }
      this.workerManager.clearTranslations((message) =>
        this.estimateTranslatedDimensions(message, null)
      );
    }

    if (
      (laneGeometryChanged || translationGeometryChanged) &&
      !options?.resetState &&
      !this.workerManager.isActive
    ) {
      const dimensions = this.overlay.getDimensions();
      if (dimensions) {
        this.laneAllocator.reset(dimensions);
        this.reflowActiveMessages(dimensions);
      }
    }

    // Re-attempt translator creation if it previously failed due to missing
    // user activation or model download. Fire-and-forget — configure() below
    // serializes behind configurePromise so they don't race.
    this.translationService.onUserActivation();

    // Invalidate pending detection when its enabled/source configuration changes.
    const sourceChanged = settings.translationSource !== prevSource;
    if (sourceChanged || wasTranslationEnabled !== settings.translationEnabled) {
      this.resetSourceDetection();
    }
    if (settings.translationEnabled) {
      this.initializeSourceDetectionPipeline();
    }

    void this.translationService
      .configure({
        enabled: settings.translationEnabled,
        service: settings.translationService,
        source: settings.translationSource,
        target: settings.translationTarget,
      })
      .catch((err: unknown) => {
        log.debug('renderer.translation.reconfigure-failed', {
          error: String(err),
        });
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
    log.debug('renderer.chat-panel.changed', { open });
  }

  protected onPause(): void {
    this.stopRenderLoop();
    this.workerManager.setPaused(true);
    this.imageFetchManager.pause();
  }

  protected onResume(): void {
    this.startRenderLoop();
    const now = performance.now();
    this.laneAllocator.resetBatch(now);
    // Use async drain for non-rAF context — allows yielding during
    // backlog processing to keep the main thread responsive.
    void this.drainQueueAsync(now);
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
    this.workerManager.clearState();
    this.backlogPaused = false;
    this.onBacklogPauseChange = null;
    clearTextMeasurementCaches();
    this.textBitmapCache.clear();
    this.dimensionCache.clear();
  }

  private initializeSourceDetectionPipeline(): void {
    this.channelMemory ??= new ChannelLanguageMemory();
    if (this.languageDetector) return;

    const detector = new LanguageDetectorService();
    this.languageDetector = detector;
    void detector.initialize().catch((err: unknown) => {
      log.debug('renderer.translation.init-failed', {
        reason: 'language-detector',
        error: String(err),
      });
      // Keep the service instance: detectFromSamples() still provides the
      // bounded Unicode fallback when native detector initialization fails.
    });
  }

  private collectSourceLanguageSample(message: ChatMessage): void {
    if (
      !this.settings.translationEnabled ||
      this.settings.translationSource !== 'auto' ||
      this.sourceDetectionDone ||
      this.sourceDetectionRun !== null ||
      !message.text.trim()
    ) {
      return;
    }

    this.sourceSampleBuffer.push(message.text);
    if (this.sourceSampleBuffer.length >= CanvasRenderer.SOURCE_SAMPLE_COUNT) {
      void this.performSourceDetection();
    }
  }

  private async performSourceDetection(): Promise<void> {
    const detector = this.languageDetector;
    if (!detector || this.sourceDetectionRun !== null) return;

    const run = Symbol('source-detection-run');
    const generation = this.sourceDetectionGeneration;
    const samples = this.sourceSampleBuffer.slice(0, CanvasRenderer.SOURCE_SAMPLE_COUNT);
    this.sourceDetectionRun = run;
    try {
      const detected = await detector.detectFromSamples(samples);
      if (
        this.sourceDetectionRun !== run ||
        this.sourceDetectionGeneration !== generation ||
        !this.settings.translationEnabled ||
        this.settings.translationSource !== 'auto'
      ) {
        return;
      }
      if (detected) {
        const channelKey = ChannelLanguageMemory.resolveKey(location.href, document);
        if (channelKey && this.channelMemory) {
          this.channelMemory.set(channelKey, detected);
        }
        await this.translationService.setDetectedSource(detected);
      }
    } catch (err: unknown) {
      log.debug('renderer.translation.source-detection-failed', {
        error: String(err),
      });
    } finally {
      if (this.sourceDetectionRun === run) {
        this.sourceDetectionRun = null;
        if (this.sourceDetectionGeneration === generation) {
          this.sourceDetectionDone = true;
          this.sourceSampleBuffer = [];
        }
      }
    }
  }

  private resetSourceDetection(): void {
    this.sourceDetectionGeneration++;
    this.sourceDetectionDone = false;
    this.sourceSampleBuffer = [];
  }

  protected onDestroy(): void {
    this._destroyed = true;
    this.stopRenderLoop();
    this.workerManager.destroy();
    this.imageFetchManager.destroy();
    this.overlayDimensionsUnsubscribe?.();
    this.overlayUserPauseUnsubscribe?.();
    this.densityIndicator.destroy();
    // Clean up prefers-reduced-motion listener
    if (this.reducedMotionQuery && this.reducedMotionListener) {
      this.reducedMotionQuery.removeEventListener('change', this.reducedMotionListener);
    }
    this.reducedMotionListener = null;
    this.reducedMotionQuery = null;
    this.statusActionButton?.remove();
    this.statusActionButton = null;
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
    this.resetSourceDetection();
    this.languageDetector?.destroy();
    this.languageDetector = null;
    this.channelMemory = null;
    // M7: Clean up offscreen observer and recovery poll
    this.stopOffscreenPoll();
    disconnectObserver(this.offscreenObserver);
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
    this.canvas = newCanvas;

    const ctx = newCanvas.getContext('2d', { desynchronized: true });
    if (!ctx) return false;

    newCanvas.addEventListener('contextlost', (e: Event) => {
      e.preventDefault();
      this.ctx = null;
      log.warn('renderer.canvas.context-lost', {
        reason: 'runtime',
      });
    });
    newCanvas.addEventListener('contextrestored', () => this.handleContextRestored());
    this.ctx = ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Re-initialize offscreen observer for the new canvas — the old observer
    // still referenced the removed canvas and would fail to detect offscreen state.
    this.setupOffscreenObserver(newCanvas);

    log.info('renderer.fallback.started', {
      reason: 'main-thread',
    });
    return true;
  }

  /**
   * Gracefully degrade from Worker-mode to main-thread rendering.
   * Called when the Worker is unrecoverable (dead or canvas context lost).
   */
  override fallbackToMainThread(reason: string): void {
    if (this._destroyed || this.fallbackInProgress) return;
    this.fallbackInProgress = true;
    log.info('renderer.fallback.started', { reason });

    void this.workerManager
      .snapshotMessages()
      .then((messages) => {
        if (this._destroyed) return;

        this.workerManager.destroy();
        this.workerManager.setActive(false);
        this.imageFetchManager.updateConfig(this.settings, null);

        if (!this.replaceCanvas()) {
          log.warn('renderer.fallback.failed', {
            reason: 'could-not-replace-canvas',
          });
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

        for (const message of messages) this.enqueueMessage(message, false);
        this.idleSince = null;
        this.startRenderLoop();

        log.info('renderer.fallback.complete', { restoredMessages: messages.length });
      })
      .catch((error: unknown) => {
        log.warn('renderer.fallback.failed', {
          reason: 'message-snapshot-failed',
          error: String(error),
        });
      })
      .finally(() => {
        this.fallbackInProgress = false;
      });
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
      log.warn('renderer.canvas.context-lost-while-worker', {
        reason: 'worker-mode',
      });
      this.fallbackToMainThread('gpu-reset-worker');
      return;
    }

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      log.warn('renderer.canvas.context-restore-failed', {
        reason: 'get-context-returned-null',
      });
      return;
    }
    this.ctx = ctx;
    // Restore DPR transform that was lost with the context
    const dims = this.overlay?.getDimensions();
    if (dims && this.canvas) {
      this.lastDpr = applyDevicePixelRatio(this.canvas, ctx, dims);
    }
    log.info('renderer.canvas.context-restored');
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
    // DISCONNECTED is rendered as a real button so only the action itself,
    // not the full-size canvas, can intercept pointer and keyboard input.
    if (status === 'disconnected') return;

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
        return t('status.connecting');
      case 'degraded':
        return t('status.unstable');
      case 'disconnected':
        return t('status.disconnected');
      case 'standby':
        return t('status.waiting');
      default:
        return '';
    }
  }
}
