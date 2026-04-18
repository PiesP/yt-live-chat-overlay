import { isAbortError } from '@core/abort';
import type { ChatHealthSnapshot } from '@core/chat-source';
import type { ModuleLogger } from '@core/logging';

export type RecoveryReason =
  | 'startup'
  | 'video-play'
  | 'foreground-return'
  | 'watchdog'
  | 'seeking';

export interface WatchdogHealthState {
  stalled: boolean;
  withinGrace: boolean;
  needsRecovery: boolean;
}

interface RecoveryCoordinatorOptions {
  readonly recoveryGraceMs: number;
  readonly getSignal: () => AbortSignal;
  readonly getHealthSnapshot: () => ChatHealthSnapshot | null;
  readonly reconnect: (signal: AbortSignal) => Promise<boolean>;
  readonly syncLatestMessages: () => Promise<void>;
  readonly isDisposed: () => boolean;
  readonly isVideoPaused: () => boolean;
  readonly log: ModuleLogger;
}

export class RecoveryCoordinator {
  private lastForegroundRecoveryAt = 0;
  private recoveryPromise: Promise<void> | null = null;
  private resumeSyncPromise: Promise<void> | null = null;

  constructor(private readonly options: RecoveryCoordinatorOptions) {}

  clear(): void {
    this.lastForegroundRecoveryAt = 0;
    this.recoveryPromise = null;
    this.resumeSyncPromise = null;
  }

  isRecovering(): boolean {
    return this.recoveryPromise !== null;
  }

  isWithinGrace(now = Date.now()): boolean {
    return now - this.lastForegroundRecoveryAt < this.options.recoveryGraceMs;
  }

  noteForegroundRecovery(now = Date.now()): void {
    this.lastForegroundRecoveryAt = now;
  }

  getWatchdogHealthState(health: ChatHealthSnapshot): WatchdogHealthState {
    const withinGrace = this.isWithinGrace();
    const stalled = !health.recentlyActive && !withinGrace;

    return {
      stalled,
      withinGrace,
      needsRecovery: !health.observerAlive || stalled,
    };
  }

  async recover(reason: RecoveryReason, forceResync = false): Promise<void> {
    if (this.options.isDisposed()) {
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

  private async runRecovery(reason: RecoveryReason, forceResync: boolean): Promise<void> {
    if (this.options.isDisposed() || this.options.isVideoPaused()) {
      return;
    }

    const health = this.options.getHealthSnapshot();
    if (!health) {
      return;
    }

    const signal = this.options.getSignal();

    try {
      const needsReconnect = forceResync || !health.observerAlive || !health.recentlyActive;
      let shouldResync = forceResync;

      if (needsReconnect) {
        this.options.log.info('Recovering chat health:', { reason, health });

        const reconnected = await this.options.reconnect(signal);
        if (!reconnected) {
          this.options.log.warn('Failed to reconnect chat during recovery');
        }

        shouldResync = true;
      }

      if (shouldResync) {
        await this.syncLatestMessagesOnResume();
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      this.options.log.warn('Chat health recovery failed:', error);
      if (forceResync) {
        await this.syncLatestMessagesOnResume();
      }
    }
  }

  private async syncLatestMessagesOnResume(): Promise<void> {
    if (this.options.isDisposed()) {
      return;
    }

    if (this.resumeSyncPromise) {
      await this.resumeSyncPromise;
      return;
    }

    const syncPromise = Promise.resolve(this.options.syncLatestMessages())
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          this.options.log.warn('Failed to sync latest messages on resume:', error);
        }
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
