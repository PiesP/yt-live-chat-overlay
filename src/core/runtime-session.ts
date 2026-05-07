import type { OverlaySettings } from '@app-types';
import { type ChatHealthSnapshot, ChatSource, type ChatSourceStartStatus } from '@core/chat-source';
import { isAbortError, throwIfAborted } from '@core/dom';
import { createLogger } from '@core/logging';
import { OVERLAY_SELECTOR, Overlay } from '@core/overlay';
import { Renderer } from '@core/renderer';
import { shouldResetRendererForSettingsChange } from '@core/settings-schema';

const log = createLogger('RuntimeSession');

const RECENT_MESSAGE_REPLAY_LIMIT = 20;
const CHAT_WATCHDOG_INTERVAL_MS = 15_000;
const CHAT_STALL_TIMEOUT_MS = 30_000;
const LONG_IDLE_RESTART_MS = 60_000;

export interface RuntimeSessionOptions {
  targetUrl: string;
  settings: OverlaySettings;
  requestRestart: (reason: RuntimeSessionRestartReason) => void;
}

export type RuntimeSessionStartStatus = 'started' | 'retryable' | 'unavailable';
export type RuntimeSessionRestartReason = 'foreground-return' | 'watchdog';

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
  private chatWatchdogTimer: number | null = null;
  private disposed = false;
  private sessionReady = false;
  private restartRequested = false;
  private hiddenSince: number | null = null;

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
    this.stopChatWatchdog();

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

    return chatSource.start((message) => {
      if (this.disposed) {
        return;
      }

      this.renderer?.addMessage(message);
    }, signal);
  }

  private removeLeftoverOverlays(): void {
    const leftoverOverlays = document.querySelectorAll(OVERLAY_SELECTOR);
    for (const element of leftoverOverlays) {
      element.remove();
    }
  }

  private noteHidden(now = Date.now()): void {
    if (this.hiddenSince === null) {
      this.hiddenSince = now;
    }
  }

  private clearHidden(): void {
    this.hiddenSince = null;
  }

  private getIdleDurationMs(now = Date.now()): number {
    return this.hiddenSince === null ? 0 : Math.max(0, now - this.hiddenSince);
  }

  private getRuntimeHealthSnapshot(now = Date.now()): {
    idleDurationMs: number;
    renderable: boolean;
    chat: ChatHealthSnapshot | null;
    shouldRestart: boolean;
  } {
    const chatSource = this.chatSource;
    const chat = chatSource
      ? chatSource.getHealthSnapshot({ activeTimeoutMs: CHAT_STALL_TIMEOUT_MS })
      : null;
    const idleDurationMs = this.getIdleDurationMs(now);
    const container = this.overlay?.getContainer();
    const dimensions = this.overlay?.getDimensions();
    const renderable = Boolean(container?.isConnected && dimensions);
    const shouldRestart =
      !renderable ||
      idleDurationMs >= LONG_IDLE_RESTART_MS ||
      (this.sessionReady && !!chat && (!chat.observerAlive || !chat.recentlyActive));

    return {
      idleDurationMs,
      renderable,
      chat,
      shouldRestart,
    };
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
        return;
      }

      if (this.disposed) {
        return;
      }

      // Clear idle markers so the health snapshot reflects current state.
      this.clearHidden();

      if (this.getRuntimeHealthSnapshot().shouldRestart) {
        this.requestManagedRestart('foreground-return');
        return;
      }

      this.renderer?.resume();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', handleVisibility));

    window.addEventListener('focus', handleVisibility);
    cleanups.push(() => window.removeEventListener('focus', handleVisibility));

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

  private startChatWatchdog(): void {
    this.chatWatchdogTimer = window.setInterval(() => {
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
      window.clearInterval(this.chatWatchdogTimer);
      this.chatWatchdogTimer = null;
    }
  }

  private replayLatestMessages(
    renderer = this.renderer,
    limit = RECENT_MESSAGE_REPLAY_LIMIT
  ): void {
    if (!renderer) {
      return;
    }

    const latestMessages = this.chatSource?.getLatestMessages(limit) ?? [];
    for (const message of latestMessages) {
      renderer.addMessage(message);
    }
  }
}
