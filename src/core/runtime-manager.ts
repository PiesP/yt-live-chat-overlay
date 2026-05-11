import type { OverlaySettings } from '@app-types';
import { createLogger } from '@core/logging';
import {
  RuntimeSession,
  type RuntimeSessionRestartReason,
  type RuntimeSessionStartStatus,
} from '@core/runtime-session';

const log = createLogger('RuntimeManager');

const NAVIGATION_SETTLE_DELAY_MS = 3500;
const START_RETRY_DELAY_MS = 2000;
const MAX_START_ATTEMPTS = 3;

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
 * - At most one RuntimeSession may be active at any time.
 * - Concurrent page/settings changes collapse into one follow-up reconcile.
 * - A stale session is disposed before a new session can be started.
 */
export class RuntimeManager {
  private readonly getCurrentUrl: RuntimeManagerOptions['getCurrentUrl'];
  private readonly getSettings: RuntimeManagerOptions['getSettings'];
  private readonly isValidPage: RuntimeManagerOptions['isValidPage'];
  private activeSession: RuntimeSession | null = null;
  private reconcileRequested = false;
  private reconcilePromise: Promise<void> | null = null;
  private scheduledReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private lastPageChangeAt = 0;
  private startFailureState: StartFailureState = {
    url: null,
    attempts: 0,
  };

  constructor(options: RuntimeManagerOptions) {
    this.getCurrentUrl = options.getCurrentUrl;
    this.getSettings = options.getSettings;
    this.isValidPage = options.isValidPage;
  }

  async start(): Promise<void> {
    await this.reconcileNow('startup');
  }

  requestReconcile(reason: ReconcileReason): void {
    if (this.destroyed) {
      return;
    }

    if (reason === 'page-change') {
      this.lastPageChangeAt = Date.now();
      this.resetStartFailures();
      const session = this.activeSession;
      if (session && !session.matchesUrl(this.getCurrentUrl())) {
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

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
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
    while (this.reconcileRequested && !this.destroyed) {
      this.reconcileRequested = false;
      await this.reconcileOnce();
    }
  }

  private async reconcileOnce(): Promise<void> {
    const desired = this.getDesiredState();
    const activeSession = this.activeSession;

    if (activeSession && (!desired.shouldRun || !activeSession.matchesUrl(desired.url))) {
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

    if (this.activeSession) {
      this.activeSession.updateSettings(desired.settings);
      return;
    }

    let session: RuntimeSession | null = null;
    const handleSessionRestart = (reason: RuntimeSessionRestartReason): void => {
      if (!session || this.destroyed || this.activeSession !== session) {
        return;
      }

      log.warn('Runtime session requested managed restart', { reason });
      this.disposeActiveSession();
      this.resetStartFailures();
      this.requestReconcile('session-restart');
    };

    session = new RuntimeSession({
      targetUrl: desired.url,
      settings: desired.settings,
      requestRestart: handleSessionRestart,
    });

    this.activeSession = session;
    const startStatus = await session.start();

    if (this.activeSession !== session || session.isDisposed()) {
      return;
    }

    if (startStatus !== 'started') {
      this.activeSession = null;
      session.dispose();
      this.handleStartFailure(desired.url, startStatus);
      return;
    }

    this.resetStartFailures();
    log.info('Runtime session started');
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
    if (this.destroyed) {
      return;
    }

    this.clearScheduledReconcile();
    this.scheduledReconcileTimer = setTimeout(() => {
      this.scheduledReconcileTimer = null;
      this.requestReconcile('retry');
    }, delayMs);
  }

  private clearScheduledReconcile(): void {
    if (this.scheduledReconcileTimer !== null) {
      clearTimeout(this.scheduledReconcileTimer);
      this.scheduledReconcileTimer = null;
    }
  }

  private disposeActiveSession(): void {
    if (!this.activeSession) {
      return;
    }

    const session = this.activeSession;
    this.activeSession = null;
    session.dispose();
  }

  private handleStartFailure(
    url: string,
    status: Exclude<RuntimeSessionStartStatus, 'started'>
  ): void {
    const attempts = this.startFailureState.url === url ? this.startFailureState.attempts + 1 : 1;
    this.startFailureState = { url, attempts };
    log.warn(`Failed to start runtime (${attempts}/${MAX_START_ATTEMPTS}) — status: ${status}`);

    if (attempts < MAX_START_ATTEMPTS) {
      // Retry for both 'retryable' and 'unavailable' — SPA navigation may
      // temporarily leave bootstrap in an unavailable state.
      this.scheduleReconcile(START_RETRY_DELAY_MS);
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
}
