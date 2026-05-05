import type { OverlaySettings } from '@app-types';
import { type ChatHealthSnapshot, ChatSource, type ChatSourceStartStatus } from '@core/chat-source';
import { ChatWatchdog } from '@core/chat-watchdog';
import { isAbortError, throwIfAborted } from '@core/dom';
import { ForegroundRecoveryManager } from '@core/foreground-recovery-manager';
import { createLogger } from '@core/logging';
import { OVERLAY_SELECTOR, Overlay } from '@core/overlay';
import { Renderer } from '@core/renderer';
import { shouldResetRendererForSettingsChange } from '@core/settings-schema';
import { VideoSync } from '@core/video-sync';

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
export type RuntimeSessionRestartReason =
  | 'foreground-return'
  | 'video-play'
  | 'watchdog'
  | 'seeking';

/**
 * Owns one full overlay runtime for a specific page URL.
 *
 * Invariants:
 * - A session owns exactly one Overlay/Renderer/ChatSource/VideoSync set.
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
  private videoSync: VideoSync | null = null;
  private readonly foregroundRecoveryManager = new ForegroundRecoveryManager();
  private readonly chatWatchdog = new ChatWatchdog();
  private disposed = false;
  private sessionReady = false;
  private restartRequested = false;
  private hiddenSince: number | null = null;
  private playbackPausedSince: number | null = null;

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

      const videoSync = new VideoSync({
        onPause: () => {
          this.notePlaybackPaused();
          this.renderer?.pause();
        },
        onPlay: () => {
          if (!this.sessionReady) {
            this.clearPlaybackPaused();
            this.renderer?.resume();
            return;
          }

          this.handleRuntimeResume('video-play');
        },
        onRateChange: (rate) => {
          log.info('Video playback rate changed:', rate);
          this.renderer?.setPlaybackRate(rate);
        },
        onSeeking: () => {
          if (!this.sessionReady) {
            return;
          }

          this.requestManagedRestart('seeking');
        },
      });
      this.videoSync = videoSync;
      await videoSync.init(signal);
      throwIfAborted(signal);

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

      this.foregroundRecoveryManager.start({
        onHide: () => {
          this.noteHidden();
          this.renderer?.pause();
        },
        onRecover: () => {
          if (document.hidden || this.disposed) {
            return;
          }

          if (this.getIdleDurationMs() >= LONG_IDLE_RESTART_MS) {
            this.requestManagedRestart('foreground-return');
            return;
          }

          if (this.videoSync?.isPaused()) {
            this.clearHidden();
            return;
          }

          this.handleRuntimeResume('foreground-return');
        },
      });

      this.chatWatchdog.start(
        {
          checkHealth: () => {
            // Skip checks while disposed, hidden, or mid-restart
            if (this.disposed || document.hidden || this.restartRequested) {
              return true;
            }

            // Skip checks while video is paused — the resume handler
            // will perform a full health check when playback resumes.
            if (this.videoSync?.isPaused() ?? true) {
              return true;
            }

            return !this.getRuntimeHealthSnapshot().shouldRestart;
          },
          onStallDetected: () => {
            this.requestManagedRestart('watchdog');
          },
        },
        CHAT_WATCHDOG_INTERVAL_MS
      );

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
    this.foregroundRecoveryManager.stop();
    this.chatWatchdog.stop();

    this.chatSource?.stop();
    this.chatSource = null;

    this.videoSync?.destroy();
    this.videoSync = null;

    this.renderer?.destroy();
    this.renderer = null;

    this.overlay?.destroy();
    this.overlay = null;
    this.hiddenSince = null;
    this.playbackPausedSince = null;

    log.info('Disposed');
  }

  private async startChatSource(signal: AbortSignal): Promise<ChatSourceStartStatus> {
    const chatSource = new ChatSource(() => this.settings);
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

  private notePlaybackPaused(now = Date.now()): void {
    if (this.playbackPausedSince === null) {
      this.playbackPausedSince = now;
    }
  }

  private clearPlaybackPaused(): void {
    this.playbackPausedSince = null;
  }

  private getIdleDurationMs(now = Date.now()): number {
    const hiddenDuration = this.hiddenSince === null ? 0 : Math.max(0, now - this.hiddenSince);
    const pausedDuration =
      this.playbackPausedSince === null ? 0 : Math.max(0, now - this.playbackPausedSince);

    return Math.max(hiddenDuration, pausedDuration);
  }

  private hasRenderableRuntime(): boolean {
    const container = this.overlay?.getContainer();
    const dimensions = this.overlay?.getDimensions();

    return Boolean(container?.isConnected && dimensions && this.videoSync?.hasVideoElement());
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
    const renderable = this.hasRenderableRuntime();
    const shouldRestart =
      !renderable ||
      idleDurationMs >= LONG_IDLE_RESTART_MS ||
      !chat ||
      !chat.observerAlive ||
      !chat.recentlyActive;

    return {
      idleDurationMs,
      renderable,
      chat,
      shouldRestart,
    };
  }

  private clearIdleMarkersForActiveState(): void {
    if (!document.hidden) {
      this.clearHidden();
    }

    if (!(this.videoSync?.isPaused() ?? false)) {
      this.clearPlaybackPaused();
    }
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

  private handleRuntimeResume(
    reason: Extract<RuntimeSessionRestartReason, 'foreground-return' | 'video-play'>
  ): void {
    if (this.disposed) {
      return;
    }

    if (this.getRuntimeHealthSnapshot().shouldRestart) {
      this.requestManagedRestart(reason);
      return;
    }

    this.clearIdleMarkersForActiveState();
    this.renderer?.resume();
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
