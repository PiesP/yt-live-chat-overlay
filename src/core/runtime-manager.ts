import type { OverlaySettings } from '@app-types';
import { overlayLog } from '@core/logging';
import { RuntimeSession } from '@core/runtime-session';

const NAVIGATION_SETTLE_DELAY_MS = 2000;
const START_RETRY_DELAY_MS = 2000;
const MAX_START_ATTEMPTS = 3;

export type ReconcileReason = 'startup' | 'page-change' | 'settings-change' | 'manual' | 'retry';

export interface RuntimeManagerOptions {
  getCurrentUrl: () => string;
  getSettings: () => Readonly<OverlaySettings>;
  isValidPage: () => boolean;
}

interface DesiredRuntimeState {
  shouldRun: boolean;
  url: string;
  settings: OverlaySettings;
}

const cloneSettings = (settings: Readonly<OverlaySettings>): OverlaySettings => ({
  ...settings,
  showAuthor: { ...settings.showAuthor },
  colors: { ...settings.colors },
  outline: { ...settings.outline },
});

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
  private scheduledReconcileTimer: number | null = null;
  private destroyed = false;
  private lastPageChangeAt = 0;
  private failedStartUrl: string | null = null;
  private failedStartAttempts = 0;

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
      this.disposeActiveSessionIfStale();
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

    const session = new RuntimeSession({
      targetUrl: desired.url,
      settings: desired.settings,
    });

    this.activeSession = session;
    const started = await session.start();

    if (this.activeSession !== session || session.isDisposed()) {
      return;
    }

    if (!started) {
      this.activeSession = null;
      session.dispose();
      this.handleStartFailure(desired.url);
      return;
    }

    this.resetStartFailures();
    overlayLog.info('[RuntimeManager] Runtime session started');
  }

  private getDesiredState(): DesiredRuntimeState {
    const settings = this.getSettings();

    return {
      shouldRun: this.isValidPage() && settings.enabled,
      url: this.getCurrentUrl(),
      settings: cloneSettings(settings),
    };
  }

  private getRemainingSettleDelay(): number {
    if (this.lastPageChangeAt === 0) {
      return 0;
    }

    const elapsed = Date.now() - this.lastPageChangeAt;
    return Math.max(0, NAVIGATION_SETTLE_DELAY_MS - elapsed);
  }

  private scheduleReconcile(delayMs: number): void {
    if (this.destroyed) {
      return;
    }

    this.clearScheduledReconcile();
    this.scheduledReconcileTimer = window.setTimeout(() => {
      this.scheduledReconcileTimer = null;
      this.requestReconcile('retry');
    }, delayMs);
  }

  private clearScheduledReconcile(): void {
    if (this.scheduledReconcileTimer === null) {
      return;
    }

    window.clearTimeout(this.scheduledReconcileTimer);
    this.scheduledReconcileTimer = null;
  }

  private disposeActiveSessionIfStale(): void {
    const activeSession = this.activeSession;
    if (!activeSession || activeSession.matchesUrl(this.getCurrentUrl())) {
      return;
    }

    this.activeSession = null;
    activeSession.dispose();
  }

  private disposeActiveSession(): void {
    if (!this.activeSession) {
      return;
    }

    const session = this.activeSession;
    this.activeSession = null;
    session.dispose();
  }

  private handleStartFailure(url: string): void {
    if (this.failedStartUrl !== url) {
      this.failedStartUrl = url;
      this.failedStartAttempts = 0;
    }

    this.failedStartAttempts += 1;
    overlayLog.warn(
      `[RuntimeManager] Failed to start runtime (${this.failedStartAttempts}/${MAX_START_ATTEMPTS})`
    );

    if (this.failedStartAttempts < MAX_START_ATTEMPTS) {
      this.scheduleReconcile(START_RETRY_DELAY_MS);
      return;
    }

    overlayLog.warn('[RuntimeManager] Giving up on automatic restart until state changes');
  }

  private resetStartFailures(): void {
    this.failedStartUrl = null;
    this.failedStartAttempts = 0;
  }
}
