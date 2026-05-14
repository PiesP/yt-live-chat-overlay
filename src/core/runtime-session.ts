import type { ChatMessage, OverlaySettings, Pauseable } from '@app-types';
import { BacklogInjectionController } from '@core/backlog-controller';
import { type ChatHealthSnapshot, ChatSource, type ChatSourceStartStatus } from '@core/chat-source';
import { findElementMatch, isAbortError, throwIfAborted, VIDEO_SELECTORS } from '@core/dom';
import { createLogger } from '@core/logging';
import { MessageIdRegistry } from '@core/message-id-registry';
import { OVERLAY_SELECTOR, Overlay } from '@core/overlay';
import { Renderer as CanvasRenderer } from '@core/renderer-canvas';
import { Renderer } from '@core/renderer-css';
import { shouldResetRendererForSettingsChange } from '@core/settings-schema';
import { VideoPauseController } from '@core/video-pause-controller';

const log = createLogger('RuntimeSession');

const RECENT_MESSAGE_REPLAY_LIMIT = 20;
const CHAT_WATCHDOG_INTERVAL_MS = 15_000;
const CHAT_STALL_TIMEOUT_MS = 30_000;
const LONG_IDLE_RESTART_MS = 60_000;

interface RuntimeSessionOptions {
  targetUrl: string;
  settings: OverlaySettings;
  requestRestart: (reason: RuntimeSessionRestartReason) => void;
}

export type RuntimeSessionStartStatus = 'started' | 'retryable' | 'unavailable';
export type RuntimeSessionRestartReason = 'foreground-return' | 'watchdog';

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
  private renderer: Renderer | CanvasRenderer | null = null;
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
      if (this.settings.rendererType === 'canvas') {
        this.renderer = new CanvasRenderer(overlay, this.settings);
      } else {
        this.renderer = new Renderer(overlay, this.settings);
      }

      const chatStarted = await this.startChatSource(signal);
      throwIfAborted(signal);

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
        showBacklogIndicator: settings.showBacklogIndicator,
        backlogMode: settings.backlogMode,
        backlogRecentMinutes: settings.backlogRecentMinutes,
      });
      renderer.setBacklogSpeedMultiplier(this.backlogController.getSpeedMultiplier());
    } else {
      renderer.setBacklogSpeedMultiplier(settings.backlogSpeedMultiplier);
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

    this.renderer?.destroy();
    this.renderer = null;

    this.overlay?.destroy();
    this.overlay = null;
    this.hiddenSince = null;

    log.info('Disposed');
  }

  private async startChatSource(signal: AbortSignal): Promise<ChatSourceStartStatus> {
    const chatSource = await ChatSource.create(() => this.settings, signal);
    this.chatSource = chatSource;

    return chatSource.start((messages: ChatMessage | ChatMessage[], isInitialSeed?: boolean) => {
      if (this.disposed) {
        return;
      }

      const renderer = this.renderer;
      if (!renderer) {
        return;
      }

      // Get messages array
      const msgs = Array.isArray(messages) ? messages : [messages];

      if (isInitialSeed && msgs.length > 50) {
        // Route to backlog controller for throttled injection
        if (!this.backlogController) {
          this.backlogController = new BacklogInjectionController(
            {
              backlogMode: this.settings.backlogMode,
              backlogMaxRate: this.settings.backlogMaxRate,
              backlogSpeedMultiplier: this.settings.backlogSpeedMultiplier,
              showBacklogIndicator: this.settings.showBacklogIndicator,
              backlogRecentMinutes: this.settings.backlogRecentMinutes,
            },
            renderer.laneCount,
            renderer.observability
          );
          // Initial sync: backlog controller is the authoritative source for
          // the speed multiplier. Subsequent updates flow through
          // updateSettings() -> backlogController.updateConfig() -> getSpeedMultiplier().
          renderer.setBacklogSpeedMultiplier(this.backlogController.getSpeedMultiplier());
          this.backlogController.onBacklogMessage = (msg) => {
            if (!this.acceptForRenderer(msg)) return;
            renderer.addMessage(msg);
          };
          renderer.onBacklogPauseChange = (paused: boolean) => {
            this.backlogController?.setPaused(paused);
          };
        }
        this.backlogController.startBacklogInjection(msgs);
        return;
      }

      // Real-time message handling (also catches backlog under 50 messages)
      for (const msg of msgs) {
        if (!this.acceptForRenderer(msg)) continue;
        renderer.addMessage(msg);
      }

      // If backlog injection is active, notify the controller so it can
      // adapt its rate to leave room for real-time messages.
      if (this.backlogController?.isBacklogActive) {
        this.backlogController.notifyRealTimeActivity();
      }
    }, signal);
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
        this.chatSource?.setPaused(false);
      }

      if (!isVideoPaused && this.getRuntimeHealthSnapshot().shouldRestart) {
        this.requestManagedRestart('foreground-return');
        return;
      }

      // Trim stale queue entries but keep high-priority recent messages
      // instead of flushing everything, which would drop important backlog
      // or real-time messages accumulated during the hidden period.
      this.renderer?.trimBackgroundQueue();
      this.renderer?.resume();
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
    if (this.chatWatchdogTimer !== null) {
      clearInterval(this.chatWatchdogTimer);
      this.chatWatchdogTimer = null;
    }
  }

  private replayLatestMessages(
    renderer: Renderer | CanvasRenderer,
    limit = RECENT_MESSAGE_REPLAY_LIMIT
  ): void {
    const latestMessages = this.chatSource?.getLatestMessages(limit) ?? [];
    for (const message of latestMessages) {
      // sessionDedup check prevents re-rendering messages already shown
      // before the renderer was reset — their ids survive seenMessageIds.clear().
      if (!this.acceptForRenderer(message)) continue;
      renderer.addMessage(message);
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
