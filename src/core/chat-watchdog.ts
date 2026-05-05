import { createLogger } from '@core/logging';

const log = createLogger('ChatWatchdog');

export interface ChatWatchdogCallbacks {
  checkHealth(): boolean;
  onStallDetected(): void;
}

const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000;

/**
 * Periodically checks chat health via the `checkHealth` callback
 * and triggers `onStallDetected` when the chat appears stalled.
 */
export class ChatWatchdog {
  private intervalId: number | null = null;

  start(callbacks: ChatWatchdogCallbacks, intervalMs: number = DEFAULT_WATCHDOG_INTERVAL_MS): void {
    if (this.intervalId !== null) {
      log.warn('ChatWatchdog already started');
      return;
    }

    this.intervalId = window.setInterval(() => {
      try {
        const isHealthy = callbacks.checkHealth();
        if (!isHealthy) {
          log.warn('Chat health check failed, triggering recovery');
          callbacks.onStallDetected();
        }
      } catch (error) {
        log.error('Chat watchdog check error:', error);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  get isRunning(): boolean {
    return this.intervalId !== null;
  }
}
