import type { OverlaySettings } from '@app-types';
import { type ChatHealthSnapshot, ChatSource, type ChatSourceStartStatus } from '@core/chat-source';
import { throwIfAborted } from '@core/dom';
import { createLogger } from '@core/logging';
import { OVERLAY_SELECTOR, Overlay } from '@core/overlay';
import { Renderer } from '@core/renderer';
import { shouldResetRendererForSettingsChange } from '@core/settings-schema';
import { clearIntervalHandle } from '@core/timers';
import { VideoSync } from '@core/video-sync';

const log = createLogger('RuntimeSession');

const RESUME_SYNC_MESSAGE_LIMIT = 20;
const CHAT_WATCHDOG_INTERVAL_MS = 15_000;
const CHAT_STALL_TIMEOUT_MS = 30_000;
const CHAT_LIVE_EDGE_THRESHOLD_PX = 24;
const CHAT_RECOVERY_GRACE_MS = 2_500;

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

type RecoveryReason = 'startup' | 'video-play' | 'foreground-return' | 'watchdog' | 'seeking';

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
  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private pageShowHandler: (() => void) | null = null;
  private chatWatchdogInterval: number | null = null;
  private lastForegroundRecoveryAt = 0;
  private disposed = false;
  private recoveryPromise: Promise<void> | null = null;
  private resumeSyncPromise: Promise<void> | null = null;

  constructor(options: RuntimeSessionOptions) {
    this.targetUrl = options.targetUrl;
    this.settings = options.settings;
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
          void this.recover('video-play', true);
        },
        onRateChange: (rate) => {
          log.info('Video playback rate changed:', rate);
          this.renderer?.setPlaybackRate(rate);
        },
        onSeeking: () => {
          this.renderer?.flushQueue();
          void this.recover('seeking', true);
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
        void this.recover('startup');
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

    const latestMessages = this.chatSource?.getLatestMessages(RESUME_SYNC_MESSAGE_LIMIT) ?? [];
    for (const message of latestMessages) {
      renderer.addMessage(message);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.abortController.abort();
    this.resumeSyncPromise = null;
    this.recoveryPromise = null;

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (this.focusHandler) {
      window.removeEventListener('focus', this.focusHandler);
      this.focusHandler = null;
    }

    if (this.pageShowHandler) {
      window.removeEventListener('pageshow', this.pageShowHandler);
      this.pageShowHandler = null;
    }

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
    const handleForegroundReturn = (): void => {
      if (document.hidden || this.videoSync?.isPaused()) {
        return;
      }

      const now = Date.now();
      if (now - this.lastForegroundRecoveryAt < CHAT_RECOVERY_GRACE_MS) {
        return;
      }

      this.lastForegroundRecoveryAt = now;
      void this.recover('foreground-return', true);
    };

    this.visibilityHandler = () => {
      if (document.hidden) {
        this.renderer?.pause();
        return;
      }

      handleForegroundReturn();
    };

    this.focusHandler = handleForegroundReturn;
    this.pageShowHandler = handleForegroundReturn;

    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('focus', this.focusHandler);
    window.addEventListener('pageshow', this.pageShowHandler);
  }

  private getChatHealthSnapshot(chatSource: ChatSource): ChatHealthSnapshot {
    return chatSource.getHealthSnapshot({
      activeTimeoutMs: CHAT_STALL_TIMEOUT_MS,
      liveEdgeThresholdPx: CHAT_LIVE_EDGE_THRESHOLD_PX,
    });
  }

  private getWatchdogHealthState(health: ChatHealthSnapshot): {
    stalled: boolean;
    withinGrace: boolean;
    needsRecovery: boolean;
  } {
    const withinGrace = Date.now() - this.lastForegroundRecoveryAt < CHAT_RECOVERY_GRACE_MS;
    const stalled = !health.recentlyActive && !withinGrace;

    return {
      stalled,
      withinGrace,
      needsRecovery: !health.observerAlive || stalled || !health.atLiveEdge,
    };
  }

  private setupChatWatchdog(): void {
    this.chatWatchdogInterval = window.setInterval(() => {
      const chatSource = this.chatSource;
      if (!chatSource || this.disposed || document.hidden) {
        return;
      }

      if (this.videoSync?.isPaused() || this.recoveryPromise) {
        return;
      }

      const health = this.getChatHealthSnapshot(chatSource);
      const { stalled, withinGrace, needsRecovery } = this.getWatchdogHealthState(health);

      if (!needsRecovery) {
        return;
      }

      log.warn('Chat unhealthy - triggering recovery', {
        health,
        stalled,
        withinGrace,
      });
      void this.recover('watchdog');
    }, CHAT_WATCHDOG_INTERVAL_MS);
  }

  private async recover(reason: RecoveryReason, forceResync = false): Promise<void> {
    if (this.disposed) return;

    if (this.recoveryPromise) {
      await this.recoveryPromise;
      if (forceResync) {
        await this.syncLatestMessagesOnResume();
      }
      return;
    }

    const recoveryPromise = this.runRecoveryBody(reason, forceResync).finally(() => {
      if (this.recoveryPromise === recoveryPromise) {
        this.recoveryPromise = null;
      }
    });

    this.recoveryPromise = recoveryPromise;
    await recoveryPromise;
  }

  private async runRecoveryBody(reason: RecoveryReason, forceResync: boolean): Promise<void> {
    if (this.disposed || this.videoSync?.isPaused()) return;

    const chatSource = this.chatSource;
    if (!chatSource) return;

    const signal = this.abortController.signal;

    try {
      chatSource.ensureLiveEdge(CHAT_LIVE_EDGE_THRESHOLD_PX);

      const health = this.getChatHealthSnapshot(chatSource);
      // forceResync marks user-visible resume events (foreground-return,
      // video-play, seeking). Background throttling or replay seeks can
      // leave the chat source logically stale while health still looks
      // acceptable, so we always rebuild the source + recent buffer on
      // those transitions. Watchdog ticks keep their health-driven
      // behavior to avoid churn during steady playback.
      const needsReconnect =
        forceResync || !health.observerAlive || !health.recentlyActive || !health.atLiveEdge;
      let shouldResync = forceResync;

      if (needsReconnect) {
        log.info('Recovering chat health:', { reason, health });

        const reconnected = await chatSource.reconnect(signal);
        if (!reconnected) {
          log.warn('Failed to reconnect chat during recovery');
        }

        chatSource.ensureLiveEdge(CHAT_LIVE_EDGE_THRESHOLD_PX);
        shouldResync = true;
      }

      if (shouldResync) {
        await this.syncLatestMessagesOnResume();
      }
    } catch (error) {
      if (isAbortError(error)) return;

      log.warn('Chat health recovery failed:', error);
      if (forceResync) {
        await this.syncLatestMessagesOnResume();
      }
    }
  }

  private async syncLatestMessagesOnResume(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.resumeSyncPromise) {
      this.renderer?.resume();
      await this.resumeSyncPromise;
      return;
    }

    const syncPromise = Promise.resolve()
      .then(() => {
        const renderer = this.renderer;
        if (!renderer) {
          return;
        }

        // Keep currently flowing comments alive; only drop stale queued backlog
        // before replaying the latest messages after recovery.
        renderer.flushQueue({ releaseMessageIds: true });
        renderer.resume();

        const latestMessages = this.chatSource?.getLatestMessages(RESUME_SYNC_MESSAGE_LIMIT) ?? [];
        for (const message of latestMessages) {
          renderer.addMessage(message);
        }
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          log.warn('Failed to sync latest messages on resume:', error);
        }
        this.renderer?.resume();
      })
      .finally(() => {
        if (this.resumeSyncPromise === syncPromise) {
          this.resumeSyncPromise = null;
        }
      });

    this.resumeSyncPromise = syncPromise;
    await syncPromise;
  }
}
