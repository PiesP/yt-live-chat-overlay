import { createLogger } from '@core/logging';

const log = createLogger('ForegroundRecoveryManager');

export interface ForegroundRecoveryCallbacks {
  onRecover(): void;
  onHide?(): void;
}

/**
 * Manages DOM event listeners for detecting when the user returns to
 * the page after being away (tab switch, window blur, page restore).
 *
 * Fires `onRecover` for visibility-visible, window-focus and
 * page-show events. Fires `onHide` for visibility-hidden.
 */
export class ForegroundRecoveryManager {
  private cleanup: (() => void) | null = null;

  start(callbacks: ForegroundRecoveryCallbacks): void {
    if (this.cleanup) {
      log.warn('ForegroundRecoveryManager already started');
      return;
    }

    const cleanups: (() => void)[] = [];

    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        callbacks.onHide?.();
        return;
      }

      callbacks.onRecover();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    cleanups.push(() => document.removeEventListener('visibilitychange', handleVisibilityChange));

    const handleRecover = (): void => {
      callbacks.onRecover();
    };
    window.addEventListener('focus', handleRecover);
    cleanups.push(() => window.removeEventListener('focus', handleRecover));

    window.addEventListener('pageshow', handleRecover);
    cleanups.push(() => window.removeEventListener('pageshow', handleRecover));

    this.cleanup = () => {
      for (const fn of cleanups) {
        fn();
      }
      this.cleanup = null;
    };
  }

  stop(): void {
    this.cleanup?.();
  }
}
