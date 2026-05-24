import type { ChatMessage, OverlaySettings, Pauseable } from '@app-types';
import { BacklogInjectionController } from '@core/backlog-controller';
import type { ChatHealthSnapshot, ChatSource, ChatSourceStartStatus } from '@core/chat-source-base';
import { LiveChatSource } from '@core/chat-source-live';
import { ReplayChatSource } from '@core/chat-source-replay';
import {
  clearSafeInterval,
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
import { CanvasRenderer } from '@core/renderer-canvas';
import { shouldResetRendererForSettingsChange } from '@core/settings-schema';
import { VideoPauseController } from '@core/video-pause-controller';
import type { ChatBootstrapResult } from '@core/youtubei-chat';
import { bootstrapChatSession } from '@core/youtubei-chat';

const log = createLogger('RuntimeSession');

const RECENT_MESSAGE_REPLAY_LIMIT = 20;
const CHAT_WATCHDOG_INTERVAL_MS = 15_000;
const STANDBY_RECHECK_INTERVAL_MS = 15_000;

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

interface RuntimeSessionOptions {
  targetUrl: string;
  settings: OverlaySettings;
  requestRestart: (reason: RuntimeSessionRestartReason) => void;
}

export type RuntimeSessionStartStatus = 'started' | 'retryable' | 'unavailable' | 'waiting';
export type RuntimeSessionRestartReason = 'foreground-return' | 'watchdog' | 'standby-resolved';

interface RuntimeHealth {
  idleDurationMs: number;
  renderable: boolean;
  chat: ChatHealthSnapshot | null;
  shouldRestart: boolean;
}

/**
 * Owns one full overlay runtime for a specific page URL.
 *
 * Invariants:
 * - A session owns exactly one Overlay/Renderer/ChatSource set.
 * - All async startup work is cancelled by one AbortController.
 * - Long-idle resume and unhealthy runtime state are handled by a managed
 *   RuntimeSession recycle instead of in-place reconnect logic.
 */
export class RuntimeSession {
  private settings: OverlaySettings;
  private readonly targetUrl: string;
  private readonly requestRestart: RuntimeSessionOptions['requestRestart'];
  private readonly abortController = new AbortController();
  private overlay: Overlay | null = null;
  private renderer: CanvasRenderer | null = null;
  private chatSource: ChatSource | null = null;
  private foregroundCleanup: (() => void) | null = null;
  private videoPauseController = new VideoPauseController();
  private backlogController: BacklogInjectionController | null = null;
  private chatWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private sessionReady = false;
  private restartRequested = false;
  private hiddenSince: number | null = null;
  /** Session-scoped registry of message IDs already rendered once. Persists across renderer resets. */
  private readonly sessionDedup = new MessageIdRegistry(5000);
  /** Unsubscribe handle for the fetch interceptor. */
  private fetchInterceptorUnsubscribe: InterceptorUnsubscribe | null = null;
  /** Unsubscribe handle for the DOM chat watcher (fallback). */
  private domWatcherUnsubscribe: DomWatcherUnsubscribe | null = null;
  /** Timer for standby periodic recheck (pre-live waiting mode). */
  private standbyPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether this session is in standby mode (pre-live, waiting for stream). */
  private standbyMode = false;

  constructor(options: RuntimeSessionOptions) {
    this.targetUrl = options.targetUrl;
    this.settings = options.settings;
    this.requestRestart = options.requestRestart;
  }

  matchesUrl(url: string): boolean {
    return this.targetUrl === url;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  async start(): Promise<RuntimeSessionStartStatus> {
    const signal = this.abortController.signal;

    try {
      this.removeLeftoverOverlays();

      const overlay = new Overlay();
      const overlayCreated = await overlay.create(this.settings, signal);
      throwIfAborted(signal);

      if (!overlayCreated) {
        overlay.destroy();
        return 'retryable';
      }

      this.overlay = overlay;
      this.renderer = new CanvasRenderer(overlay, this.settings);

      const chatStarted = await this.startChatSource(signal);
      throwIfAborted(signal);

      if (chatStarted === 'waiting') {
        this.enterStandbyMode();
        log.info('Entered standby mode — waiting for stream to start');
        return 'started';
      }

      if (chatStarted !== 'started') {
        return chatStarted;
      }

      this.sessionReady = true;

      // Foreground recovery: listen for tab/window visibility changes
      if (document.hidden) {
        this.noteHidden();
      }

      this.startForegroundListeners();
      this.startVideoPauseListeners();

      this.startChatWatchdog();

      log.info('Started successfully');
      return 'started';
    } catch (error) {
      if (isAbortError(error)) {
        return 'retryable';
      }

      log.warn('Failed to start:', error);
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
  updateSettings(settings: OverlaySettings): void {
    if (this.disposed) {
      return;
    }

    const shouldResetRenderer = shouldResetRendererForSettingsChange(this.settings, settings);
    this.settings = settings;
    this.overlay?.updateSettings(settings);

    const renderer = this.renderer;
    if (!renderer) {
      return;
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
      });
    }

    if (!shouldResetRenderer) {
      return;
    }

    this.replayLatestMessages(renderer);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.exitStandbyMode();

    this.disposed = true;
    this.sessionReady = false;
    this.restartRequested = true;
    this.abortController.abort();
    this.stopForegroundListeners();
    this.stopVideoPauseListeners();
    this.stopChatWatchdog();

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

    this.overlay?.destroy();
    this.overlay = null;
    this.hiddenSince = null;

    log.info('Disposed');
  }

  private async startChatSource(signal: AbortSignal): Promise<ChatSourceStartStatus> {
    const { chatSource, bootstrapResult } = await createChatSource(() => this.settings, signal);
    this.chatSource = chatSource;

    // Seed bootstrap data from factory call to avoid duplicate watch page fetch
    seedBootstrapIfReady(chatSource, bootstrapResult);

    // Install fetch interceptor to eavesdrop on YouTube's own chat requests.
    // This delivers messages ~1 poll interval earlier than our own polling.
    //
    // Disabled for replay — ReplayChatSource handles its own fetching via the
    // background fetch interval and the interceptor would inject duplicate
    // messages, flooding the queue.
    if (!(chatSource instanceof ReplayChatSource)) {
      this.installFetchInterceptor(chatSource);
    }

    return chatSource.start((messages, isInitialSeed) => {
      if (this.disposed) return;
      const renderer = this.renderer;
      if (!renderer) return;

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

      const isReplayBatch = isInitialSeed === false && msgs.length >= 2;
      if (isReplayBatch || msgs.length > 50) {
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
        () => this.settings,
        (messages) => {
          if (this.disposed) return;
          chatSource.injectExternalMessages(messages);
        }
      );
    } catch (error) {
      log.warn('Failed to install fetch interceptor:', error);
    }

    // Install DOM watcher as a fallback. It captures messages from
    // YouTube's own chat UI rendering, which works even if the fetch
    // interceptor misses a response (URL pattern change, etc.).
    try {
      this.domWatcherUnsubscribe = installDomChatWatcher((messages) => {
        if (this.disposed) return;
        chatSource.injectExternalMessages(messages);
      });
    } catch (error) {
      log.warn('Failed to install DOM chat watcher:', error);
    }
  }

  private ensureBacklogController(renderer: CanvasRenderer): void {
    if (this.backlogController) return;

    this.backlogController = new BacklogInjectionController(
      {
        backlogMode: this.settings.backlogMode,
        backlogMaxRate: this.settings.backlogMaxRate,
        backlogSpeedMultiplier: this.settings.backlogSpeedMultiplier,
        backlogRecentMinutes: this.settings.backlogRecentMinutes,
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
    const renderable = !!(container?.isConnected && dimensions);

    // When the video is paused, chat is intentionally idle — don't treat
    // it as stalled. Without this guard the watchdog would trigger a
    // restart every CHAT_STALL_TIMEOUT_MS (30 s) and the new session
    // would immediately hit the same state, causing a restart loop.
    const video = this.getVideoElement();
    const isVideoPaused = video?.paused ?? true;

    const shouldRestart =
      !isVideoPaused &&
      (!renderable ||
        idleDurationMs >= LONG_IDLE_RESTART_MS ||
        (this.sessionReady && !!chat && (!chat.observerAlive || !chat.recentlyActive)));

    return { idleDurationMs, renderable, chat, shouldRestart };
  }

  private requestManagedRestart(reason: RuntimeSessionRestartReason): void {
    if (this.disposed || this.restartRequested) {
      return;
    }

    this.restartRequested = true;
    const health = this.getRuntimeHealthSnapshot();
    log.warn('Requesting managed runtime restart', { reason, health });
    this.requestRestart(reason);
  }

  private startForegroundListeners(): void {
    const cleanups: (() => void)[] = [];

    const handleVisibility = (): void => {
      if (document.hidden) {
        this.noteHidden();
        this.renderer?.pause();
        this.renderer?.trimBackgroundQueue();
        this.chatSource?.setPaused(true);
        return;
      }

      if (this.disposed) {
        return;
      }

      // Clear idle markers so the health snapshot reflects current state.
      this.clearHidden();

      // When video is paused, keep chat paused too — the renderer won't
      // display comments (resume() early-returns on isVideoPaused), so
      // polling would just waste API calls and YouTube quota.
      const video = this.getVideoElement();
      const isVideoPaused = video?.paused ?? true;
      if (!isVideoPaused) {
        // Trim stale queue entries BEFORE unpausing chat — otherwise
        // freshly arrived messages in the window between setPaused(false)
        // and resume() would be dropped by the trim.
        this.renderer?.trimBackgroundQueue();
        this.chatSource?.setPaused(false);
      }

      if (!isVideoPaused && this.getRuntimeHealthSnapshot().shouldRestart) {
        this.requestManagedRestart('foreground-return');
        return;
      }

      // When video is paused, keep renderer paused too. Calling resume()
      // while video is paused clears isPaused prematurely — when the user
      // later presses play, resumeForVideo() -> resume() would early-return
      // because isPaused is already false, leaving the render loop stopped.
      if (!isVideoPaused) {
        this.renderer?.resume();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', handleVisibility));

    window.addEventListener('pageshow', handleVisibility);
    cleanups.push(() => window.removeEventListener('pageshow', handleVisibility));

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
          // Trim stale queue entries before resuming — when the user
          // returns from hidden+video-paused state, handleVisibility
          // skipped trim+resume. The pendingQueue may have accumulated
          // messages during the hidden period. Trimming here prevents
          // a visual flood when drainQueue fires on resume.
          this.renderer?.trimBackgroundQueue();
          this.renderer?.resumeForVideo();
          if (!document.hidden) {
            this.chatSource?.setPaused(false);
          }
        }
      },
    };
    this.videoPauseController.start({
      pauseable: videoPauseable,
      isDisposed: () => this.disposed,
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
        if (this.disposed || document.hidden || this.restartRequested) {
          return;
        }

        // Skip checks while video is paused — the renderer intentionally
        // stops processing messages, so idle chat is expected.
        const video = this.getVideoElement();
        if (video?.paused) return;

        if (this.getRuntimeHealthSnapshot().shouldRestart) {
          log.warn('Chat health check failed, triggering recovery');
          this.requestManagedRestart('watchdog');
        }
      } catch (error) {
        log.error('Chat watchdog check error:', error);
      }
    }, CHAT_WATCHDOG_INTERVAL_MS);
  }

  private stopChatWatchdog(): void {
    this.chatWatchdogTimer = clearSafeInterval(this.chatWatchdogTimer);
  }

  // ── Standby mode (pre-live waiting) ─────────────────────────────────────

  private enterStandbyMode(): void {
    this.standbyMode = true;
    this.renderer?.setStandbyStatus(true);

    this.standbyPollTimer = setInterval(() => {
      void this.pollStandbyResolution();
    }, STANDBY_RECHECK_INTERVAL_MS);
  }

  private exitStandbyMode(): void {
    this.standbyMode = false;
    this.stopStandbyPolling();
    this.renderer?.setStandbyStatus(false);
  }

  private stopStandbyPolling(): void {
    this.standbyPollTimer = clearSafeInterval(this.standbyPollTimer);
  }

  private async pollStandbyResolution(): Promise<void> {
    if (this.disposed || !this.standbyMode) return;

    try {
      const result = await bootstrapChatSession(this.abortController.signal);
      if (result.status === 'ready') {
        log.info('Stream detected — requesting managed restart from standby');
        this.stopStandbyPolling();
        this.requestManagedRestart('standby-resolved');
      }
    } catch (error) {
      if (!isAbortError(error)) {
        log.warn('Standby poll failed:', error);
      }
    }
  }

  private replayLatestMessages(
    renderer: CanvasRenderer,
    limit = RECENT_MESSAGE_REPLAY_LIMIT
  ): void {
    const latestMessages = this.chatSource?.getLatestMessages(limit) ?? [];
    for (const message of latestMessages) {
      // sessionDedup check prevents re-rendering messages already shown
      // before the renderer was reset — their ids survive seenMessageIds.clear().
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
}
