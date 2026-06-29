// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings, Pauseable } from '@app-types';
import { BacklogInjectionController } from '@core/backlog-controller';
import type { ChatHealthSnapshot, ChatSource, ChatSourceStartStatus } from '@core/chat-source-base';
import { LiveChatSource } from '@core/chat-source-live';
import { ReplayChatSource } from '@core/chat-source-replay';
import {
  clearSafeInterval,
  clearSafeTimeout,
  findElementMatch,
  isAbortError,
  throwIfAborted,
  VIDEO_SELECTORS,
} from '@core/dom';
import type { DomWatcherUnsubscribe } from '@core/dom-chat-watcher';
import { installDomChatWatcher } from '@core/dom-chat-watcher';
import type { InterceptorUnsubscribe } from '@core/fetch-interceptor';
import { installFetchInterceptor } from '@core/fetch-interceptor';
import { createLogger } from '@core/logging';
import { MessageIdRegistry } from '@core/message-id-registry';
import { OVERLAY_SELECTOR, Overlay } from '@core/overlay';
import type { ConnectionStatus, RendererBase } from '@core/renderer-base';
import { CanvasRenderer } from '@core/renderer-canvas';
import { RendererWebGL2 } from '@core/renderer-webgl2';
import { RendererWebGL2Worker } from '@core/renderer-webgl2-worker';
import { shouldResetRendererForSettingsChange } from '@core/settings-schema';
import { StandbyController } from '@core/standby-controller';
import { VideoPauseController } from '@core/video-pause-controller';
import { isYouTubeWatch } from '@core/youtube-url-pattern';
import type { ChatBootstrapResult } from '@core/youtubei-chat';
import { bootstrapChatSession } from '@core/youtubei-chat';

/** Runtime lifecycle state machine — replaces ad-hoc boolean flags. */
const RUNTIME_STATES = [
  'init',
  'starting',
  'active',
  'restarting',
  'disposed',
  'destroyed',
] as const;
type RuntimeState = (typeof RUNTIME_STATES)[number];

const log = createLogger('RuntimeManager');

const NAVIGATION_SETTLE_DELAY_MS = 2000;
/** Retry delays with exponential backoff: 2 s → 4 s → 8 s. */
const START_RETRY_DELAYS_MS = [2000, 4000, 8000] as const;
const MAX_START_ATTEMPTS = 3;

const RECENT_MESSAGE_REPLAY_LIMIT = 20;
const CHAT_WATCHDOG_INTERVAL_MS = 15_000;

/**
 * YouTube chat panel root element selector.
 *
 * On pages with live chat or chat replay, YouTube renders a
 * `<ytd-live-chat-frame id="chat">` custom element inside
 * `#chat-container`.  On VOD pages the element is absent.
 *
 * Used as a pre-filter before the expensive `fetchWatchHtml() +
 * ytInitialData deep-parse` pipeline — skip the network round-trip
 * when the DOM clearly tells us there is no chat.
 */
const CHAT_PANEL_SELECTOR = '#chat';

async function createChatSource(
  getSettings: () => Readonly<OverlaySettings>,
  signal?: AbortSignal
): Promise<{ chatSource: ChatSource; bootstrapResult: ChatBootstrapResult }> {
  const result = await bootstrapChatSession(signal);
  const chatSource =
    result.status === 'ready' && result.data?.isReplay
      ? new ReplayChatSource(getSettings)
      : new LiveChatSource(getSettings);

  return { chatSource, bootstrapResult: result };
}

function seedBootstrapIfReady(chatSource: ChatSource, result: ChatBootstrapResult): void {
  if (result.status === 'ready') {
    chatSource.setInitialBootstrap(result.data);
  }
}

const CHAT_STALL_TIMEOUT_MS = 30_000;
const LONG_IDLE_RESTART_MS = 60_000;
const ABSOLUTE_MAX_IDLE_RESTART_MS = 30 * 60 * 1000; // 30 minutes

export type RuntimeSessionRestartReason = 'foreground-return' | 'watchdog' | 'standby-resolved';

interface RuntimeHealth {
  idleDurationMs: number;
  renderable: boolean;
  chat: ChatHealthSnapshot | null;
  shouldRestart: boolean;
}

type ReconcileReason = 'startup' | 'page-change' | 'settings-change' | 'retry' | 'session-restart';

interface RuntimeManagerOptions {
  getCurrentUrl: () => string;
  getSettings: () => Readonly<OverlaySettings>;
  isValidPage: () => boolean;
}

interface DesiredRuntimeState {
  shouldRun: boolean;
  url: string;
  settings: OverlaySettings;
}

interface StartFailureState {
  url: string | null;
  attempts: number;
}

/**
 * Serializes all runtime transitions behind one reconcile loop.
 *
 * Invariants:
 * - At most one full overlay runtime may be active at any time.
 * - Concurrent page/settings changes collapse into one follow-up reconcile.
 * - A stale runtime is disposed before a new one can be started.
 */
export class RuntimeManager {
  private readonly getCurrentUrl: RuntimeManagerOptions['getCurrentUrl'];
  private readonly getSettings: RuntimeManagerOptions['getSettings'];
  private readonly isValidPage: RuntimeManagerOptions['isValidPage'];
  private reconcileRequested = false;

  /** Message count threshold for routing batches through backlog injection. */
  private static readonly BACKLOG_BATCH_THRESHOLD = 50;
  /** Lane utilization threshold (0–1) triggering backlog routing for small batches. */
  private static readonly BACKLOG_UTILIZATION_THRESHOLD = 0.8;
  /** Minimum message count for utilization-aware small-batch routing. */
  private static readonly SMALL_BATCH_THRESHOLD = 5;
  private reconcilePromise: Promise<void> | null = null;
  private scheduledReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPageChangeAt = 0;
  /**
   * Set when the current reconcile was triggered by a SPA page change.
   * Consumed once by reconcileOnce() to gate the DOM pre-filter — only
   * SPA navigations skip the expensive bootstrap when #chat is absent.
   * Startup, settings-change, and session-restart always go through the
   * full pipeline to avoid false negatives on scheduled streams
   * (LIVE_STREAM_OFFLINE whose chat panel may not be in the DOM yet).
   */
  private isPageChangeReconcile = false;
  private startFailureState: StartFailureState = {
    url: null,
    attempts: 0,
  };

  // Session fields (null when no session is active)
  private settings: OverlaySettings | null = null;
  private targetUrl: string | null = null;
  private abortController = new AbortController();
  private overlay: Overlay | null = null;
  private renderer: RendererBase | null = null;
  private chatSource: ChatSource | null = null;
  private foregroundCleanup: (() => void) | null = null;
  private videoPauseController = new VideoPauseController();
  private readonly standbyController: StandbyController;
  private backlogController: BacklogInjectionController | null = null;
  private chatWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private state: RuntimeState = 'init';
  private hiddenSince: number | null = null;
  /** Session-scoped registry of message IDs already rendered once. Persists across renderer resets. */
  private readonly sessionDedup = new MessageIdRegistry(5000);
  /** Unsubscribe handle for the fetch interceptor. */
  private fetchInterceptorUnsubscribe: InterceptorUnsubscribe | null = null;
  /** Unsubscribe handle for the DOM chat watcher (fallback). */
  private domWatcherUnsubscribe: DomWatcherUnsubscribe | null = null;

  private get isDisposedState(): boolean {
    return this.state === 'disposed' || this.state === 'restarting' || this.state === 'destroyed';
  }

  private get isActiveState(): boolean {
    return this.state === 'starting' || this.state === 'active';
  }

  constructor(options: RuntimeManagerOptions) {
    this.getCurrentUrl = options.getCurrentUrl;
    this.getSettings = options.getSettings;
    this.isValidPage = options.isValidPage;
    this.standbyController = new StandbyController(
      () => this.abortController.signal,
      () => this.isDisposedState,
      (reason) => this.requestManagedRestart(reason)
    );
  }

  async start(): Promise<void> {
    await this.reconcileNow('startup');
  }

  requestReconcile(reason: ReconcileReason): void {
    if (this.state === 'destroyed') {
      return;
    }

    if (reason === 'page-change') {
      this.lastPageChangeAt = Date.now();
      this.isPageChangeReconcile = true;
      this.resetStartFailures();
      if (this.targetUrl !== null && !this.matchesSessionUrl(this.getCurrentUrl())) {
        this.disposeActiveSession();
      }
    }

    this.reconcileRequested = true;
    this.clearScheduledReconcile();
    void this.ensureReconcileLoop();
  }

  async reconcileNow(reason: ReconcileReason): Promise<void> {
    this.requestReconcile(reason);
    await this.ensureReconcileLoop();
  }

  /**
   * Dispose the current runtime session and immediately start a fresh one.
   * Called by App.restartRuntime() for manual recovery from degraded states.
   */
  async restartSession(): Promise<void> {
    if (this.state === 'destroyed') return;
    this.disposeActiveSession();
    await this.reconcileNow('session-restart');
  }

  destroy(): void {
    if (this.state === 'destroyed') {
      return;
    }

    this.state = 'destroyed';
    this.clearScheduledReconcile();
    this.disposeActiveSession();
  }

  private ensureReconcileLoop(): Promise<void> {
    if (this.reconcilePromise) {
      return this.reconcilePromise;
    }

    this.reconcilePromise = this.runReconcileLoop().finally(() => {
      this.reconcilePromise = null;
    });

    return this.reconcilePromise;
  }

  private async runReconcileLoop(): Promise<void> {
    while (this.reconcileRequested && this.state !== 'destroyed') {
      this.reconcileRequested = false;
      try {
        await this.reconcileOnce();
      } catch (err) {
        log.warn('reconcileOnce() threw an error, continuing loop:', err);
      }
    }
  }

  private async reconcileOnce(): Promise<void> {
    const desired = this.getDesiredState();
    const hasActiveSession = this.targetUrl !== null && !this.isDisposedState;

    if (hasActiveSession && (!desired.shouldRun || !this.matchesSessionUrl(desired.url))) {
      this.disposeActiveSession();
    }

    if (!desired.shouldRun) {
      this.resetStartFailures();
      return;
    }

    const remainingSettleDelay = this.getRemainingSettleDelay();
    if (remainingSettleDelay > 0) {
      this.scheduleReconcile(remainingSettleDelay);
      return;
    }

    if (this.targetUrl !== null && !this.isDisposedState) {
      this.updateSessionSettings(desired.settings);
      return;
    }

    // ── DOM-based chat panel pre-filter (SPA page changes only) ──────
    //
    // When the user navigates via SPA to a /watch page that has no #chat
    // (YTD-LIVE-CHAT-FRAME) element in the DOM, the page is almost
    // certainly a VOD.  Skip the expensive `fetchWatchHtml() +
    // ytInitialData deep-parse` pipeline and return `unavailable`
    // immediately.
    //
    // Applied ONLY for page-change reconciles — startup, settings-change,
    // and session-restart always go through the full bootstrap to avoid
    // false negatives on scheduled streams (LIVE_STREAM_OFFLINE) whose
    // chat panel is not yet rendered.
    //
    // Before blocking, check playabilityStatus from window.ytInitialData.
    // Scheduled streams (LIVE_STREAM_OFFLINE) may lack #chat in the DOM
    // but will transition later — let the full bootstrap detect standby.
    const isPageChange = this.isPageChangeReconcile;
    this.isPageChangeReconcile = false;
    if (
      isPageChange &&
      isYouTubeWatch(location.href) &&
      !document.querySelector(CHAT_PANEL_SELECTOR)
    ) {
      const playbackStatus = (window.ytInitialData as Record<string, unknown> | undefined)
        ?.playabilityStatus as { status?: string } | undefined;
      if (playbackStatus?.status === 'LIVE_STREAM_OFFLINE') {
        log.info(
          '#chat absent but playabilityStatus is LIVE_STREAM_OFFLINE — proceeding to bootstrap'
        );
      } else {
        log.info('No #chat element in DOM — skipping bootstrap (likely VOD)');
        // Set failure state directly (bypass handleStartFailure) — the
        // Chat unavailable  warning is misleading for what is actually a
        // successful optimisation: we correctly identified a VOD and
        // avoided the expensive bootstrap pipeline.
        this.startFailureState = { url: desired.url, attempts: MAX_START_ATTEMPTS };
        return;
      }
    }

    // Initialize session state from desired state
    this.targetUrl = desired.url;
    this.settings = desired.settings;

    // Set restarting state BEFORE aborting so that async operations
    // checking isDisposedState (e.g., visibility handler) see the
    // correct state during the transition window.
    this.state = 'restarting';

    this.abortController.abort(); // abort stale signal before replacing
    this.abortController = new AbortController();
    this.state = 'starting';

    const startStatus = await this.startSession();

    if (this.isDisposedState) {
      return;
    }

    if (startStatus === 'waiting') {
      // Session entered standby mode — keep it alive.
      // The session itself handles periodic recheck and transition.
      this.resetStartFailures();
      log.info('Runtime session in standby (waiting for stream start)');
      return;
    }

    if (startStatus !== 'started') {
      this.disposeActiveSession();
      this.handleStartFailure(desired.url, startStatus);
      return;
    }

    this.resetStartFailures();
    log.info('Runtime session started');
  }

  private handleSessionRestart(reason: RuntimeSessionRestartReason): void {
    if (this.state === 'destroyed' || this.state === 'restarting') {
      return;
    }

    log.info('Runtime session requested managed restart', { reason });

    // Soft restart: keep Overlay + Canvas + BacklogController alive,
    // restart only the chat source chain. This avoids visible UI flicker
    // and duplicates the lightweight retry that replay sources already use.
    this.restartChatSourceSoft();
    this.resetStartFailures();
    this.requestReconcile('session-restart');
  }

  private computeConnectionStatus(): ConnectionStatus {
    // Standby mode takes priority
    if (this.standbyController.isStandby()) {
      return 'standby';
    }

    // No active session → connecting
    if (!this.chatSource || this.isDisposedState) {
      return 'connecting';
    }

    const health = this.chatSource.getHealthSnapshot();

    // Circuit breaker tripped (consecutiveErrors >= failureLimit) → disconnected
    if (health.consecutiveErrors >= this.getSettings().livePollFailureLimit) {
      return 'disconnected';
    }

    // Errors occurring but still retrying → degraded
    if (health.consecutiveErrors > 0) {
      return 'degraded';
    }

    // Normal operation
    if (health.observerAlive && health.recentlyActive) {
      return 'connected';
    }

    // Observer alive but not recently active → connecting
    if (health.observerAlive) {
      return 'connecting';
    }

    // Observer not alive → disconnected
    return 'disconnected';
  }

  /**
   * Restart only the chat source while preserving Overlay, CanvasRenderer,
   * and BacklogController. A full disposeActiveSession is reserved for
   * page changes or explicit shutdown.
   */
  private restartChatSourceSoft(): void {
    this.stopForegroundListeners();
    this.stopVideoPauseListeners();
    this.stopChatWatchdog();

    this.fetchInterceptorUnsubscribe?.();
    this.fetchInterceptorUnsubscribe = null;

    this.domWatcherUnsubscribe?.();
    this.domWatcherUnsubscribe = null;

    // Destroy the backlog controller — it references the current renderer
    // and chat source. A new one will be created in startSession() with
    // the new renderer. Keeping it alive across the soft restart would
    // cause onBacklogMessage to reference the stale (about-to-be-replaced)
    // renderer, leading to messages being added to a destroyed session.
    this.backlogController?.destroy();
    this.backlogController = null;

    // Abort the controller BEFORE stopping the chat source so in-flight
    // async operations (e.g. seek handlers) get the abort signal.
    this.abortController?.abort();
    this.chatSource?.stop();
    this.chatSource = null;

    // Reset session dedup in case restarting on the same page.
    this.sessionDedup.clear();

    // Clear targetUrl so reconcileOnce knows to call startSession()
    // to rebuild the chat source chain. Keep overlay/renderer alive.
    this.targetUrl = null;
    this.abortController = new AbortController();
  }

  private matchesSessionUrl(url: string): boolean {
    return this.targetUrl === url;
  }

  private async startSession(): Promise<ChatSourceStartStatus> {
    const signal = this.abortController.signal;
    const settings = this.settings as OverlaySettings;

    try {
      this.removeLeftoverOverlays();

      const overlay = new Overlay();
      const overlayCreated = await overlay.create(settings, signal);
      throwIfAborted(signal);

      if (!overlayCreated) {
        overlay.destroy();
        return 'retryable';
      }

      this.overlay = overlay;
      this.renderer = this.createRenderer(overlay, settings);
      this.renderer.setConnectionStatus('connecting');
      this.renderer.onStatusBarClick = () => {
        log.info('Status bar click — restarting session');
        void this.restartSession();
      };
      this.standbyController.setRenderer(this.renderer);

      const chatStarted = await this.startChatSource(signal);
      throwIfAborted(signal);

      if (chatStarted === 'waiting') {
        // Start foreground listeners so the render loop pauses when the
        // tab is hidden — avoids wasted GPU/CPU during long standby waits.
        if (document.visibilityState !== 'visible') {
          this.noteHidden();
        }
        this.startForegroundListeners();
        this.standbyController.enter();
        log.info('Entered standby mode — waiting for stream to start');
        return 'started';
      }

      if (chatStarted !== 'started') {
        return chatStarted;
      }

      this.state = 'active';

      // Foreground recovery: listen for tab/window visibility changes
      if (document.visibilityState !== 'visible') {
        this.noteHidden();
      }

      this.startForegroundListeners();
      this.startVideoPauseListeners();
      this.startChatWatchdog();

      log.info('Started successfully');
      return 'started';
    } catch (error: unknown) {
      // Ensure watchdog is stopped if startup failed after startChatWatchdog()
      this.stopChatWatchdog();
      if (isAbortError(error)) {
        return 'retryable';
      }

      log.info('Failed to start:', error);
      return 'retryable';
    }
  }

  /**
   * Propagate new settings to all owned subsystems.
   *
   * Propagation order is intentional:
   *   1. Compute shouldResetRenderer against the *previous* settings
   *   2. Update session-level settings reference (SSOT for this session)
   *   3. Overlay — may trigger ResizeObserver via updateDimensions()
   *   4. Renderer — uses the new settings for all subsequent rendering
   *   5. BacklogController — syncs config then pushes multiplier to Renderer
   *
   * All subsystems receive the same settings object reference, so there
   * is no stale-copy risk within a single updateSettings() call.
   */
  private updateSessionSettings(settings: OverlaySettings): void {
    if (!this.isActiveState || !this.settings) {
      return;
    }

    const shouldResetRenderer = shouldResetRendererForSettingsChange(this.settings, settings);
    const prevLanguage = this.settings?.language;
    this.settings = settings;
    this.overlay?.updateSettings(settings);

    // Update overlay lang attribute when language changes
    if (settings.language !== undefined && settings.language !== prevLanguage) {
      this.overlay?.updateLanguage();
    }

    const renderer = this.renderer;
    if (!renderer) {
      return;
    }

    // C2: When the renderer is reset (visual settings change), clear session dedup
    // so that replayLatestMessages() can re-inject the recent messages. Without this,
    // messages visible before the reset are blocked by their own IDs surviving in the
    // session-scoped dedup registry.
    if (shouldResetRenderer) {
      this.sessionDedup.clear();
    }

    renderer.updateSettings(settings, { resetState: shouldResetRenderer });

    // Update backlog controller config if it exists, then sync the
    // effective speed multiplier back to the renderer through a single
    // code path. The backlog controller is the authoritative source for
    // the multiplier applied to backlog message animations.
    if (this.backlogController) {
      this.backlogController.updateConfig({
        backlogMaxRate: settings.backlogMaxRate,
        backlogSpeedMultiplier: settings.backlogSpeedMultiplier,
        backlogMode: settings.backlogMode,
        backlogRecentMinutes: settings.backlogRecentMinutes,
        backlogInjectionMax: settings.backlogInjectionMax,
        backlogDensityRampMs: settings.backlogDensityRampMs,
        backlogDensityRampMaxMs: settings.backlogDensityRampMaxMs,
        backlogInjectionRateMin: settings.backlogInjectionRateMin,
      });
    }

    if (!shouldResetRenderer) {
      return;
    }

    this.replayLatestMessages(renderer);
  }

  private disposeSession(): void {
    if (this.isDisposedState) {
      return;
    }

    this.standbyController.exit();

    this.state = 'restarting';

    // Stop event listeners BEFORE aborting — abort handlers may throw,
    // and we want listeners cleaned up regardless.
    this.stopForegroundListeners();
    this.stopVideoPauseListeners();
    this.stopChatWatchdog();

    this.abortController.abort();

    this.backlogController?.destroy();
    this.backlogController = null;

    this.chatSource?.stop();
    this.chatSource = null;

    this.fetchInterceptorUnsubscribe?.();
    this.fetchInterceptorUnsubscribe = null;

    this.domWatcherUnsubscribe?.();
    this.domWatcherUnsubscribe = null;

    this.renderer?.destroy();
    this.renderer = null;
    this.standbyController.setRenderer(null);

    this.overlay?.destroy();
    this.overlay = null;
    this.hiddenSince = null;

    this.sessionDedup.clear();

    log.info('Disposed');
  }

  private async startChatSource(signal: AbortSignal): Promise<ChatSourceStartStatus> {
    const settings = this.settings as OverlaySettings;
    const { chatSource, bootstrapResult } = await createChatSource(() => settings, signal);
    this.chatSource = chatSource;

    // Seed bootstrap data from factory call to avoid duplicate watch page fetch
    seedBootstrapIfReady(chatSource, bootstrapResult);

    // Short-circuit when the stream hasn't started yet (LIVE_STREAM_OFFLINE).
    // The chat source's internal resolver would waste time retrying — return
    // 'waiting' immediately and let the standby poll timer detect stream start.
    if (bootstrapResult.status === 'waiting') {
      log.info('Stream not yet started — entering standby without starting chat source');
      return 'waiting';
    }

    // Install fetch interceptor to eavesdrop on YouTube's own chat requests.
    // This delivers messages ~1 poll interval earlier than our own polling.
    //
    // Disabled for replay — ReplayChatSource handles its own fetching via the
    // background fetch interval and the interceptor would inject duplicate
    // messages, flooding the queue.
    if (!(chatSource instanceof ReplayChatSource)) {
      this.installFetchInterceptor(chatSource);
    }

    // Wire renderer's BurstDetector EMA rate into the chat source for
    // sub-poll-interval burst reactivity in adaptive delay calculation.
    // Without this, the poll loop needs >=2 samples (2 poll intervals) before
    // it can detect a burst and shorten its poll delay.
    if (this.renderer) {
      chatSource.burstRateProvider = () => this.renderer?.getBurstEmaRate() ?? 0;
    }

    return chatSource.start((messages, _isInitialSeed) => {
      if (this.isDisposedState) return;
      const renderer = this.renderer;
      if (!renderer) return;

      // Clear standby on first message arrival — must happen before routing
      // decisions (backlog, timestamp paths return early and skip it otherwise).
      renderer.setStandbyStatus(false);

      const msgs = Array.isArray(messages) ? messages : [messages];

      // Replay messages carry videoOffsetMs from YouTube's API — they have
      // exact timing and should bypass the backlog controller entirely.
      // The rAF flush loop in ReplayChatSource already handles frame-accurate
      // emission; Poisson spacing would distort the timing.
      //
      // Live chat initial seed batches (> 50 messages) still go through the
      // backlog controller for burst protection.
      const hasVideoTimestamps = msgs.some((m) => m.videoOffsetMs !== undefined);
      if (hasVideoTimestamps) {
        for (const msg of msgs) {
          if (!this.acceptForRenderer(msg)) continue;
          renderer.addMessage(msg);
        }
        return;
      }

      if (msgs.length > RuntimeManager.BACKLOG_BATCH_THRESHOLD) {
        this.ensureBacklogController(renderer);
        this.backlogController?.startBacklogInjection(msgs);
        return;
      }

      // Clear standby on first message arrival (idempotent).
      renderer.setStandbyStatus(false);

      // Utilization-aware throttle for live bursts: when lanes are >80% full,
      // route through the backlog controller even for small batches so messages
      // get Poisson-spaced injection instead of hitting the pendingQueue all at
      // once. Without this, live poll responses (20-50 msgs) bypass the backlog
      // controller entirely, flooding the queue during bursts.
      const utilization = renderer.getLaneUtilization();
      if (
        utilization >= RuntimeManager.BACKLOG_UTILIZATION_THRESHOLD &&
        msgs.length >= RuntimeManager.SMALL_BATCH_THRESHOLD
      ) {
        this.ensureBacklogController(renderer);
        this.backlogController?.startBacklogInjection(msgs);
        return;
      }

      for (const msg of msgs) {
        if (!this.acceptForRenderer(msg)) continue;
        renderer.addMessage(msg);
      }

      if (this.backlogController?.isBacklogActive) {
        this.backlogController.notifyRealTimeActivity();
      }
    }, signal);
  }

  /**
   * Install a fetch interceptor that eavesdrops on YouTube's own
   * get_live_chat requests and forwards parsed messages to the ChatSource.
   */
  private installFetchInterceptor(chatSource: ChatSource): void {
    try {
      this.fetchInterceptorUnsubscribe = installFetchInterceptor(
        () => this.settings as OverlaySettings,
        (messages) => {
          if (this.isDisposedState) return;
          chatSource.injectExternalMessages(messages);
        }
      );
    } catch (error: unknown) {
      log.info('Failed to install fetch interceptor:', error);
    }

    // Install DOM watcher as a fallback. It captures messages from
    // YouTube's own chat UI rendering, which works even if the fetch
    // interceptor misses a response (URL pattern change, etc.).
    try {
      this.domWatcherUnsubscribe = installDomChatWatcher((messages) => {
        if (this.isDisposedState) return;
        chatSource.injectExternalMessages(messages);
      });
    } catch (error: unknown) {
      log.info('Failed to install DOM chat watcher:', error);
    }
  }

  private ensureBacklogController(renderer: RendererBase): void {
    if (this.backlogController) return;

    const settings = this.settings as OverlaySettings;
    this.backlogController = new BacklogInjectionController(
      {
        backlogMode: settings.backlogMode,
        backlogMaxRate: settings.backlogMaxRate,
        backlogSpeedMultiplier: settings.backlogSpeedMultiplier,
        backlogRecentMinutes: settings.backlogRecentMinutes,
        backlogInjectionMax: settings.backlogInjectionMax,
        backlogDensityRampMs: settings.backlogDensityRampMs,
        backlogDensityRampMaxMs: settings.backlogDensityRampMaxMs,
        backlogInjectionRateMin: settings.backlogInjectionRateMin,
      },
      renderer.laneCount,
      renderer.observability
    );

    this.backlogController.onBacklogMessage = (msg) => {
      if (!this.acceptForRenderer(msg)) return;
      renderer.addMessage(msg);
    };

    renderer.onBacklogPauseChange = (paused: boolean) => {
      this.backlogController?.setPaused(paused);
    };

    this.backlogController.onUtilizationQuery = () => renderer.getLaneUtilization();
  }

  private removeLeftoverOverlays(): void {
    const leftoverOverlays = document.querySelectorAll(OVERLAY_SELECTOR);
    for (const element of leftoverOverlays) {
      element.remove();
    }
  }

  private noteHidden(): void {
    if (this.hiddenSince === null) {
      this.hiddenSince = Date.now();
    }
  }

  private clearHidden(): void {
    this.hiddenSince = null;
  }

  private getIdleDurationMs(now = Date.now()): number {
    return this.hiddenSince === null ? 0 : Math.max(0, now - this.hiddenSince);
  }

  private getRuntimeHealthSnapshot(now = Date.now()): RuntimeHealth {
    const chat =
      this.chatSource?.getHealthSnapshot({ activeTimeoutMs: CHAT_STALL_TIMEOUT_MS }) ?? null;
    const idleDurationMs = this.getIdleDurationMs(now);
    const container = this.overlay?.getContainer();
    const dimensions = this.overlay?.getDimensions();
    const renderable = (container?.isConnected ?? false) && dimensions != null;

    // Pre-live standby has no chat source — never restart from health checks.
    if (this.standbyController.isStandby()) {
      return { idleDurationMs: 0, renderable, chat: null, shouldRestart: false };
    }

    // When the video is paused, chat is intentionally idle — don't treat
    // it as stalled. Without this guard the watchdog would trigger a
    // restart every CHAT_STALL_TIMEOUT_MS (30 s) and the new session
    // would immediately hit the same state, causing a restart loop.
    const video = this.getVideoElement();
    const isVideoPaused = video?.paused ?? true;

    // When the chat source is in intentional fetch backoff (e.g. replay
    // source after consecutive failures), the silence is expected — don't
    // override its own recovery with a full runtime restart.
    const isChatInBackoff = chat?.isInBackoff ?? false;

    const isVeryLongIdle = idleDurationMs >= ABSOLUTE_MAX_IDLE_RESTART_MS;
    const shouldRestart =
      isVeryLongIdle ||
      (!isVideoPaused &&
        !isChatInBackoff &&
        (!renderable ||
          idleDurationMs >= LONG_IDLE_RESTART_MS ||
          (this.state === 'active' &&
            chat != null &&
            (!chat.observerAlive || !chat.recentlyActive))));

    return { idleDurationMs, renderable, chat, shouldRestart };
  }

  private requestManagedRestart(reason: RuntimeSessionRestartReason): void {
    if (this.isDisposedState) {
      return;
    }

    // Clear watchdog synchronously before state transition so the interval
    // callback cannot fire after we've moved to 'restarting' and trigger
    // a double restart.
    this.stopChatWatchdog();

    this.state = 'restarting';
    const health = this.getRuntimeHealthSnapshot();
    log.info('Requesting managed runtime restart', { reason, health });
    this.handleSessionRestart(reason);
  }

  private startForegroundListeners(): void {
    // Clean up any previously registered listeners from a prior startSession() call.
    // Without this, a managed restart would leak the old visibilitychange/pageshow
    // listeners, causing double-execution of resume logic.
    this.stopForegroundListeners();

    const cleanups: (() => void)[] = [];

    const handleVisibility = (): void => {
      if (document.visibilityState !== 'visible') {
        this.noteHidden();
        this.renderer?.pause();
        this.renderer?.trimBackgroundQueue();
        this.chatSource?.setPaused(true);
        return;
      }

      if (this.isDisposedState) {
        return;
      }

      // Clear idle markers so the health snapshot reflects current state.
      this.clearHidden();

      // In standby mode (pre-live, waiting for stream), just resume the
      // render loop — no chat source or video state to manage.
      if (this.standbyController.isStandby()) {
        this.renderer?.resume();
        return;
      }

      // Always resume on foreground return — the renderer gate-checks
      // isVideoPaused internally. On pre-live pages, the DOM video.paused
      // is true (countdown), but isVideoPaused is false (not user-initiated),
      // so the render loop correctly restarts. Chat source resume ensures
      // messages accumulated during the hidden period are processed.
      this.renderer?.trimBackgroundQueue();
      this.chatSource?.setPaused(false);

      // If the chat source accumulated messages during the hidden period
      // (ReplayChatSource buffers them), drain through the backlog controller
      // for gradual emission instead of letting them burst out directly.
      if (this.renderer && this.chatSource instanceof ReplayChatSource) {
        const messages = this.chatSource.drainPendingMessages();
        if (messages.length > 0) {
          this.ensureBacklogController(this.renderer);
          this.backlogController?.startBacklogInjection(messages);
        }
      }

      this.renderer?.resume();

      // After a hidden period, verify the chat source is still alive.
      // During hidden time the poll loop was paused, so observerAlive may
      // have flipped without the watchdog catching it (watchdog skips
      // hidden tabs). If the chat source died while we were away, trigger
      // a managed restart immediately rather than waiting for the next
      // watchdog tick.
      if (this.state === 'active' && this.chatSource) {
        const chatHealth = this.chatSource.getHealthSnapshot({
          activeTimeoutMs: CHAT_STALL_TIMEOUT_MS,
        });
        if (!chatHealth.observerAlive && !this.standbyController.isStandby()) {
          log.info('Chat source observer died during hidden period — triggering recovery');
          this.requestManagedRestart('foreground-return');
          return;
        }
      }

      if (this.getRuntimeHealthSnapshot().shouldRestart) {
        this.requestManagedRestart('foreground-return');
        return;
      }
    };

    // Single handler for both visibilitychange and pageshow — handles
    // tab visibility changes and bfcache restores uniformly.
    document.addEventListener('visibilitychange', handleVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', handleVisibility));

    // bfcache restore: when the page is restored from the browser cache
    // (event.persisted === true), the previous JS state may be stale —
    // the chat source poll loop could be dead, the renderer paused, etc.
    // Force a full reconcile to re-validate the session.
    const handlePageShow = (e: PageTransitionEvent): void => {
      if (e.persisted) {
        log.info('Page restored from bfcache — forcing session reconcile');
        this.requestReconcile('page-change');
      } else {
        // Non-bfcache pageshow: treat same as visibility change
        handleVisibility();
      }
    };
    window.addEventListener('pageshow', handlePageShow);
    cleanups.push(() => window.removeEventListener('pageshow', handlePageShow));

    this.foregroundCleanup = () => {
      for (const fn of cleanups) {
        fn();
      }
      this.foregroundCleanup = null;
    };
  }

  private stopForegroundListeners(): void {
    this.foregroundCleanup?.();
  }

  // ── Video pause/play listeners ────────────────────────────────────────────

  private startVideoPauseListeners(): void {
    const videoPauseable: Pauseable = {
      setPaused: (paused: boolean) => {
        if (paused) {
          this.renderer?.pauseForVideo();
          this.chatSource?.setPaused(true);
        } else {
          // Trim stale queue entries before resuming — messages may have
          // accumulated during the paused period. Trimming prevents a visual
          // flood when drainQueue fires on resume. Always unpause the chat
          // source so the poll loop wakes even when the tab is hidden
          // (e.g. unpause via media keys on a second screen).
          this.renderer?.trimBackgroundQueue();
          this.renderer?.resumeForVideo();
          this.chatSource?.setPaused(false);
        }
      },
    };
    this.videoPauseController.start({
      pauseable: videoPauseable,
      isDisposed: () => this.isDisposedState,
    });
  }

  private stopVideoPauseListeners(): void {
    this.videoPauseController.stop();
  }

  private getVideoElement(): HTMLVideoElement | null {
    const match = findElementMatch<HTMLVideoElement>(VIDEO_SELECTORS);
    return match?.element ?? null;
  }

  private startChatWatchdog(): void {
    this.chatWatchdogTimer = setInterval(() => {
      try {
        // Skip checks while disposed, hidden, or mid-restart
        if (this.isDisposedState || document.visibilityState !== 'visible') {
          return;
        }

        // Skip checks while video is paused — the renderer intentionally
        // stops processing messages, so idle chat is expected.
        const video = this.getVideoElement();
        if (video?.paused) return;

        if (this.getRuntimeHealthSnapshot().shouldRestart) {
          log.info('Chat health check failed, triggering recovery');
          this.requestManagedRestart('watchdog');
          return;
        }

        // Propagate connection status to renderer for visual feedback
        const connStatus = this.computeConnectionStatus();
        this.renderer?.setConnectionStatus(connStatus);
      } catch (error: unknown) {
        log.warn('Chat watchdog check error:', error);
      }
    }, CHAT_WATCHDOG_INTERVAL_MS);
  }

  private stopChatWatchdog(): void {
    this.chatWatchdogTimer = clearSafeInterval(this.chatWatchdogTimer);
  }

  private replayLatestMessages(renderer: RendererBase, limit = RECENT_MESSAGE_REPLAY_LIMIT): void {
    const latestMessages = this.chatSource?.getLatestMessages(limit) ?? [];
    for (const message of latestMessages) {
      // sessionDedup check prevents re-rendering messages already shown
      // before the renderer was reset — their ids survive renderer-level clear operations.
      if (!this.acceptForRenderer(message)) continue;
      renderer.replayMessage(message);
    }
  }

  /**
   * Accept a message for rendering only if its id has not been rendered
   * already in this session.  This guard survives renderer resets so that
   * replayLatestMessages and backlog re-injection never re-emit messages
   * that were already shown on screen.
   *
   * Messages without an id (rare edge case) are always accepted.
   */
  private acceptForRenderer(message: ChatMessage): boolean {
    if (!message.id) return true;
    if (this.sessionDedup.has(message.id)) return false;
    this.sessionDedup.mark(message.id);
    return true;
  }

  private getDesiredState(): DesiredRuntimeState {
    const settings = this.getSettings();

    return {
      shouldRun: this.isValidPage() && settings.enabled,
      url: this.getCurrentUrl(),
      settings,
    };
  }

  private getRemainingSettleDelay(): number {
    if (this.lastPageChangeAt === 0) {
      return 0;
    }

    // YouTube SPA navigation mutates the player/chat DOM after the URL changes.
    const elapsed = Date.now() - this.lastPageChangeAt;
    return Math.max(0, NAVIGATION_SETTLE_DELAY_MS - elapsed);
  }

  private scheduleReconcile(delayMs: number): void {
    if (this.state === 'destroyed') {
      return;
    }

    this.clearScheduledReconcile();
    this.scheduledReconcileTimer = setTimeout(() => {
      this.scheduledReconcileTimer = null;
      this.requestReconcile('retry');
    }, delayMs);
  }

  private clearScheduledReconcile(): void {
    this.scheduledReconcileTimer = clearSafeTimeout(this.scheduledReconcileTimer);
  }

  private disposeActiveSession(): void {
    // Capture targetUrl before nulling — the act of reading + nulling is the
    // re-entrant guard. If disposeSession re-enters disposeActiveSession,
    // targetUrl is already null and the second call becomes a no-op.
    const _url = this.targetUrl;
    this.targetUrl = null;
    this.settings = null;
    void _url;
    this.disposeSession();
    this.abortController = new AbortController();
  }

  private handleStartFailure(url: string, status: Exclude<ChatSourceStartStatus, 'started'>): void {
    // Structural 'unavailable' means the page has no chat renderer at all.
    // Retrying won't help — the only recovery path is a page change (SPA navigation).
    // Bypass retries and wait for a page-change event to reset the failure state.
    if (status === 'unavailable') {
      this.startFailureState = { url, attempts: MAX_START_ATTEMPTS };
      log.warn('Chat unavailable on this page — waiting for page change, not retrying');
      return;
    }

    const attempts = this.startFailureState.url === url ? this.startFailureState.attempts + 1 : 1;
    this.startFailureState = { url, attempts };
    log.warn(`Failed to start runtime (${attempts}/${MAX_START_ATTEMPTS}) — status: ${status}`);

    if (attempts < MAX_START_ATTEMPTS) {
      // Exponential backoff: 2 s → 4 s → 8 s
      const delay = START_RETRY_DELAYS_MS[attempts - 1] ?? 8000;
      this.scheduleReconcile(delay);
      return;
    }

    log.warn('Giving up on automatic restart until state changes');
  }

  private resetStartFailures(): void {
    this.startFailureState = {
      url: null,
      attempts: 0,
    };
  }

  /**
   * Create the appropriate renderer based on settings.
   * Tries WebGL2 SDF worker first (best for CPU-heavy atlas generation),
   * falls back to main-thread WebGL2, then Canvas2D.
   */
  private createRenderer(overlay: Overlay, settings: OverlaySettings): RendererBase {
    if (settings.enableWebGL2) {
      // Try OffscreenCanvas worker first (best for CPU-heavy atlas gen)
      if (typeof OffscreenCanvas !== 'undefined') {
        try {
          const renderer = new RendererWebGL2Worker(overlay, settings);
          log.info('Using WebGL2 SDF worker renderer');
          return renderer;
        } catch (err: unknown) {
          log.info('WebGL2 worker unavailable, trying main-thread WebGL2:', err);
        }
      }
      // Fall back to main-thread WebGL2
      try {
        const renderer = new RendererWebGL2(overlay, settings);
        log.info('Using WebGL2 SDF renderer (main thread)');
        return renderer;
      } catch (err: unknown) {
        log.info('WebGL2 SDF renderer unavailable, falling back to Canvas2D:', err);
      }
    }
    log.info('Using Canvas2D renderer');
    return new CanvasRenderer(overlay, settings);
  }
}
