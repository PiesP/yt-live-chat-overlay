import type { OverlaySettings } from '@app-types';
import { ChatSource } from '@core/chat-source';
import { throwIfAborted } from '@core/dom';
import { overlayLog } from '@core/logging';
import { OVERLAY_SELECTOR, Overlay } from '@core/overlay';
import { Renderer } from '@core/renderer';
import { VideoSync } from '@core/video-sync';

const RESUME_SYNC_MESSAGE_LIMIT = 20;
const CHAT_WATCHDOG_INTERVAL_MS = 15_000;
const CHAT_STALL_TIMEOUT_MS = 30_000;
const CHAT_LIVE_EDGE_THRESHOLD_PX = 24;
const CHAT_RECOVERY_GRACE_MS = 2_500;

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

export interface RuntimeSessionOptions {
  targetUrl: string;
  settings: OverlaySettings;
}

/**
 * Owns one full overlay runtime for a specific page URL.
 *
 * Invariants:
 * - A session owns exactly one Overlay/Renderer/ChatSource/VideoSync set.
 * - All async startup and recovery work is cancelled by one AbortController.
 * - Visibility, watchdog, and playback resume all converge on one recover() path.
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
  private chatWatchdogInterval: number | null = null;
  private hiddenWhilePlaying = false;
  private lastVisibilityReturnAt = 0;
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

  async start(): Promise<boolean> {
    const signal = this.abortController.signal;

    try {
      this.removeLeftoverOverlays();

      const overlay = new Overlay();
      const overlayCreated = await overlay.create(this.settings, signal);
      throwIfAborted(signal);

      if (!overlayCreated) {
        overlay.destroy();
        return false;
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
          overlayLog.info('[RuntimeSession] Video playback rate changed:', rate);
          this.renderer?.setPlaybackRate(rate);
        },
        onSeeking: () => {
          this.renderer?.flushQueue();
        },
      });
      this.videoSync = videoSync;
      await videoSync.init(signal);
      throwIfAborted(signal);

      this.setupVisibilityHandler();

      const chatSource = new ChatSource(() => this.settings);
      this.chatSource = chatSource;

      const chatStarted = await chatSource.start((message) => {
        if (this.disposed) {
          return;
        }

        this.renderer?.addMessage(message);
      }, signal);
      throwIfAborted(signal);

      if (!chatStarted) {
        return false;
      }

      this.setupChatWatchdog();
      overlayLog.info('[RuntimeSession] Started successfully');
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        return false;
      }

      overlayLog.warn('[RuntimeSession] Failed to start:', error);
      return false;
    }
  }

  updateSettings(settings: OverlaySettings): void {
    if (this.disposed) {
      return;
    }

    this.settings = settings;
    this.overlay?.updateSettings(settings);
    this.renderer?.updateSettings(settings);
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

    if (this.chatWatchdogInterval !== null) {
      window.clearInterval(this.chatWatchdogInterval);
      this.chatWatchdogInterval = null;
    }

    this.hiddenWhilePlaying = false;
    this.lastVisibilityReturnAt = 0;

    this.chatSource?.stop();
    this.chatSource = null;

    this.videoSync?.destroy();
    this.videoSync = null;

    this.renderer?.destroy();
    this.renderer = null;

    this.overlay?.destroy();
    this.overlay = null;

    this.removeLeftoverOverlays();
    overlayLog.info('[RuntimeSession] Disposed');
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

  private setupVisibilityHandler(): void {
    this.visibilityHandler = () => {
      if (document.hidden) {
        if (!this.renderer?.isPausedState()) {
          this.renderer?.pause();
          this.hiddenWhilePlaying = true;
        }
        return;
      }

      this.lastVisibilityReturnAt = Date.now();
      if (!this.hiddenWhilePlaying) {
        return;
      }

      this.hiddenWhilePlaying = false;
      void this.recover('visibility-return', true);
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
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

      const health = chatSource.getHealthSnapshot({
        activeTimeoutMs: CHAT_STALL_TIMEOUT_MS,
        liveEdgeThresholdPx: CHAT_LIVE_EDGE_THRESHOLD_PX,
      });

      const withinGrace = Date.now() - this.lastVisibilityReturnAt < CHAT_RECOVERY_GRACE_MS;
      const stalled = !health.recentlyActive && !withinGrace;
      const needsRecovery = !health.observerAlive || stalled || !health.atLiveEdge;

      if (!needsRecovery) {
        return;
      }

      overlayLog.warn('[RuntimeSession] Chat unhealthy - triggering recovery', {
        health,
        stalled,
        withinGrace,
      });
      void this.recover('watchdog');
    }, CHAT_WATCHDOG_INTERVAL_MS);
  }

  private async recover(reason: string, forceResync = false): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.recoveryPromise) {
      await this.recoveryPromise;
      if (forceResync) {
        await this.syncLatestMessagesOnResume();
      }
      return;
    }

    const recoveryPromise = this.runRecovery(reason, forceResync).finally(() => {
      if (this.recoveryPromise === recoveryPromise) {
        this.recoveryPromise = null;
      }
    });

    this.recoveryPromise = recoveryPromise;
    await recoveryPromise;
  }

  private async runRecovery(reason: string, forceResync: boolean): Promise<void> {
    if (this.disposed || this.videoSync?.isPaused()) {
      return;
    }

    const signal = this.abortController.signal;
    const chatSource = this.chatSource;
    if (!chatSource) {
      return;
    }

    try {
      chatSource.ensureLiveEdge(CHAT_LIVE_EDGE_THRESHOLD_PX);

      const health = chatSource.getHealthSnapshot({
        activeTimeoutMs: CHAT_STALL_TIMEOUT_MS,
        liveEdgeThresholdPx: CHAT_LIVE_EDGE_THRESHOLD_PX,
      });

      const needsReconnect = !health.observerAlive || !health.recentlyActive || !health.atLiveEdge;
      let shouldResync = forceResync;

      if (needsReconnect) {
        overlayLog.info('[RuntimeSession] Recovering chat health:', {
          reason,
          health,
        });

        const reconnected = await chatSource.reconnect(signal);
        throwIfAborted(signal);

        if (!reconnected) {
          overlayLog.warn('[RuntimeSession] Failed to reconnect chat during recovery');
        }

        chatSource.ensureLiveEdge(CHAT_LIVE_EDGE_THRESHOLD_PX);
        shouldResync = true;
      }

      if (shouldResync) {
        await this.syncLatestMessagesOnResume();
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      overlayLog.warn('[RuntimeSession] Chat health recovery failed:', error);
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

        renderer.resetForResync();
        renderer.resume();

        const latestMessages = this.chatSource?.getLatestMessages(RESUME_SYNC_MESSAGE_LIMIT) ?? [];
        for (const message of latestMessages) {
          renderer.addMessage(message);
        }
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          overlayLog.warn('[RuntimeSession] Failed to sync latest messages on resume:', error);
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
