import type { OverlaySettings } from '@app-types';
import { isAbortError } from '@core/abort';
import { type ChatHealthSnapshot, ChatSource, type ChatSourceStartStatus } from '@core/chat-source';
import { throwIfAborted } from '@core/dom';
import { createLogger } from '@core/logging';
import { OVERLAY_SELECTOR, Overlay } from '@core/overlay';
import { Renderer } from '@core/renderer';
import { RecoveryCoordinator } from '@core/runtime-recovery';
import { shouldResetRendererForSettingsChange } from '@core/settings-schema';
import { clearIntervalHandle } from '@core/timers';
import { VideoSync } from '@core/video-sync';

const log = createLogger('RuntimeSession');

const RESUME_SYNC_MESSAGE_LIMIT = 20;
const CHAT_WATCHDOG_INTERVAL_MS = 15_000;
const CHAT_STALL_TIMEOUT_MS = 30_000;
const CHAT_RECOVERY_GRACE_MS = 2_500;

export interface RuntimeSessionOptions {
  targetUrl: string;
  settings: OverlaySettings;
}

export type RuntimeSessionStartStatus = 'started' | 'retryable' | 'unavailable';

/**
 * Owns one full overlay runtime for a specific page URL.
 *
 * Invariants:
 * - A session owns exactly one Overlay/Renderer/ChatSource/VideoSync set.
 * - All async startup and recovery work is cancelled by one AbortController.
 * - Foreground return, watchdog, and playback resume all converge on one recover() path.
 */
export class RuntimeSession {
  private settings: OverlaySettings;
  private readonly targetUrl: string;
  private readonly abortController = new AbortController();
  private overlay: Overlay | null = null;
  private renderer: Renderer | null = null;
  private chatSource: ChatSource | null = null;
  private videoSync: VideoSync | null = null;
  private foregroundRecoveryCleanup: (() => void) | null = null;
  private chatWatchdogInterval: number | null = null;
  private disposed = false;
  private readonly recoveryCoordinator: RecoveryCoordinator;

  constructor(options: RuntimeSessionOptions) {
    this.targetUrl = options.targetUrl;
    this.settings = options.settings;
    this.recoveryCoordinator = new RecoveryCoordinator({
      recoveryGraceMs: CHAT_RECOVERY_GRACE_MS,
      getSignal: () => this.abortController.signal,
      getHealthSnapshot: () => {
        const chatSource = this.chatSource;
        return chatSource ? this.getChatHealthSnapshot(chatSource) : null;
      },
      reconnect: async (signal) => this.chatSource?.reconnect(signal) ?? false,
      syncLatestMessages: () => this.syncLatestMessagesOnResume(),
      isDisposed: () => this.disposed,
      isVideoPaused: () => this.videoSync?.isPaused() ?? false,
      log,
    });
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
          this.renderer?.pause();
        },
        onPlay: () => {
          void this.recoveryCoordinator.recover('video-play', true);
        },
        onRateChange: (rate) => {
          log.info('Video playback rate changed:', rate);
          this.renderer?.setPlaybackRate(rate);
        },
        onSeeking: () => {
          this.renderer?.flushQueue();
          void this.recoveryCoordinator.recover('seeking', true);
        },
      });
      this.videoSync = videoSync;
      await videoSync.init(signal);
      throwIfAborted(signal);

      this.setupForegroundRecoveryHandlers();
      const chatStarted = await this.startChatSource(signal);
      throwIfAborted(signal);

      if (chatStarted === 'unavailable') {
        return chatStarted;
      }

      this.setupChatWatchdog();
      if (chatStarted === 'retryable') {
        log.warn('Chat source was not ready during startup; recovery will continue in-session');
        void this.recoveryCoordinator.recover('startup');
      }

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
    this.abortController.abort();
    this.recoveryCoordinator.clear();
    this.foregroundRecoveryCleanup?.();
    this.foregroundRecoveryCleanup = null;

    this.chatWatchdogInterval = clearIntervalHandle(this.chatWatchdogInterval);

    this.chatSource?.stop();
    this.chatSource = null;

    this.videoSync?.destroy();
    this.videoSync = null;

    this.renderer?.destroy();
    this.renderer = null;

    this.overlay?.destroy();
    this.overlay = null;

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
      if (this.overlay?.getContainer() === element) {
        continue;
      }

      element.remove();
    }
  }

  private setupForegroundRecoveryHandlers(): void {
    this.foregroundRecoveryCleanup?.();

    const handleForegroundReturn = (): void => {
      if (document.hidden || this.videoSync?.isPaused()) {
        return;
      }

      const now = Date.now();
      if (this.recoveryCoordinator.isWithinGrace(now)) {
        return;
      }

      this.recoveryCoordinator.noteForegroundRecovery(now);
      void this.recoveryCoordinator.recover('foreground-return', true);
    };

    const visibilityHandler = (): void => {
      if (document.hidden) {
        this.renderer?.pause();
        return;
      }

      handleForegroundReturn();
    };

    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('focus', handleForegroundReturn);
    window.addEventListener('pageshow', handleForegroundReturn);

    this.foregroundRecoveryCleanup = () => {
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('focus', handleForegroundReturn);
      window.removeEventListener('pageshow', handleForegroundReturn);
    };
  }

  private getChatHealthSnapshot(chatSource: ChatSource): ChatHealthSnapshot {
    return chatSource.getHealthSnapshot({
      activeTimeoutMs: CHAT_STALL_TIMEOUT_MS,
    });
  }

  private setupChatWatchdog(): void {
    this.chatWatchdogInterval = window.setInterval(() => {
      const chatSource = this.chatSource;
      if (!chatSource || this.disposed || document.hidden) {
        return;
      }

      if (this.videoSync?.isPaused() || this.recoveryCoordinator.isRecovering()) {
        return;
      }

      const health = this.getChatHealthSnapshot(chatSource);
      const { stalled, withinGrace, needsRecovery } =
        this.recoveryCoordinator.getWatchdogHealthState(health);

      if (!needsRecovery) {
        return;
      }

      log.warn('Chat unhealthy - triggering recovery', {
        health,
        stalled,
        withinGrace,
      });
      void this.recoveryCoordinator.recover('watchdog');
    }, CHAT_WATCHDOG_INTERVAL_MS);
  }

  private replayLatestMessages(renderer = this.renderer, limit = RESUME_SYNC_MESSAGE_LIMIT): void {
    if (!renderer) {
      return;
    }

    const latestMessages = this.chatSource?.getLatestMessages(limit) ?? [];
    for (const message of latestMessages) {
      renderer.addMessage(message);
    }
  }

  private async syncLatestMessagesOnResume(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const renderer = this.renderer;
    if (!renderer) {
      return;
    }

    try {
      // Keep currently flowing comments alive; only drop stale queued backlog
      // before replaying the latest messages after recovery.
      renderer.flushQueue({ releaseMessageIds: true });
      renderer.resume();
      this.replayLatestMessages(renderer);
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
      renderer.resume();
      throw error;
    }
  }
}
