import type { ChatMessage, OverlaySettings } from '@app-types';
import { BacklogInjectionController } from '@core/backlog-controller';
import { type ChatHealthSnapshot, ChatSource, type ChatSourceStartStatus } from '@core/chat-source';
import { findElementMatch, isAbortError, throwIfAborted, VIDEO_SELECTORS } from '@core/dom';
import { createLogger } from '@core/logging';
import { MessageIdRegistry } from '@core/message-id-registry';
import { OVERLAY_SELECTOR, Overlay } from '@core/overlay';
import { Renderer } from '@core/renderer';
import { shouldResetRendererForSettingsChange } from '@core/settings-schema';

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
  private renderer: Renderer | null = null;
  private chatSource: ChatSource | null = null;
  private foregroundCleanup: (() => void) | null = null;
  private videoPauseCleanup: (() => void) | null = null;
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
      this.renderer = new Renderer(overlay, this.settings);

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

    // Update backlog controller config if it exists
    if (this.backlogController) {
      this.backlogController.updateConfig({
        backlogMaxRate: settings.backlogMaxRate,
        backlogSpeedMultiplier: settings.backlogSpeedMultiplier,
        showBacklogIndicator: settings.showBacklogIndicator,
        backlogMode: settings.backlogMode,
        backlogRecentMinutes: settings.backlogRecentMinutes,
      });
    }

    // Sync backlog speed multiplier to renderer for any future backlog messages
    renderer.setBacklogSpeedMultiplier(settings.backlogSpeedMultiplier);

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
          this.backlogController.onBacklogMessage = (msg) => {
            if (!this.acceptForRenderer(msg)) return;
            renderer.setBacklogSpeedMultiplier(this.backlogController?.getSpeedMultiplier() ?? 1);
            renderer.addMessage(msg);
          };
          renderer.onBacklogPauseChange = (paused) => {
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
      this.hiddenSince = performance.now();
    }
  }

  private clearHidden(): void {
    this.hiddenSince = null;
  }

  private getIdleDurationMs(now = performance.now()): number {
    return this.hiddenSince === null ? 0 : Math.max(0, now - this.hiddenSince);
  }

  private getRuntimeHealthSnapshot(now = performance.now()): RuntimeHealth {
    const chat =
      this.chatSource?.getHealthSnapshot({ activeTimeoutMs: CHAT_STALL_TIMEOUT_MS }) ?? null;
    const idleDurationMs = this.getIdleDurationMs(now);
    const container = this.overlay?.getContainer();
    const dimensions = this.overlay?.getDimensions();
    const renderable = !!(container?.isConnected && dimensions);
    const shouldRestart =
      !renderable ||
      idleDurationMs >= LONG_IDLE_RESTART_MS ||
      (this.sessionReady && !!chat && (!chat.observerAlive || !chat.recentlyActive));

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
      this.chatSource?.setPaused(false);

      if (this.getRuntimeHealthSnapshot().shouldRestart) {
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
    const video = this.getVideoElement();
    if (!video) {
      log.debug('No video element found — video pause handling disabled');
      return;
    }

    const handlePause = (): void => {
      if (this.disposed) return;
      log.debug('Video paused — pausing comment flow');
      this.renderer?.pauseForVideo();
    };

    const handlePlay = (): void => {
      if (this.disposed) return;
      log.debug('Video playing — resuming comment flow');
      this.renderer?.resumeForVideo();
    };

    video.addEventListener('pause', handlePause);
    video.addEventListener('play', handlePlay);

    this.videoPauseCleanup = () => {
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('play', handlePlay);
      this.videoPauseCleanup = null;
    };
  }

  private stopVideoPauseListeners(): void {
    this.videoPauseCleanup?.();
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

  private replayLatestMessages(renderer: Renderer, limit = RECENT_MESSAGE_REPLAY_LIMIT): void {
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
