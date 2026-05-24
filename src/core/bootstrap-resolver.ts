import { sleep, throwIfAborted } from '@core/dom';
import { createLogger } from '@core/logging';
import type { ChatBootstrapData, ChatBootstrapResult } from '@core/youtubei-chat';
import { bootstrapChatSession } from '@core/youtubei-chat';

const log = createLogger('BootstrapResolver');

const BOOTSTRAP_MAX_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_DELAY_MS = 1000;

interface ChatBootstrapResolution {
  status: 'ready' | 'retryable' | 'unavailable' | 'waiting';
  bootstrap?: ChatBootstrapData;
  reason: string;
}

/**
 * Resolves YouTube chat bootstrap configuration from the page's embedded data.
 * Retries up to BOOTSTRAP_MAX_ATTEMPTS times if the initial attempt fails.
 */
export class BootstrapResolver {
  /**
   * Resolves bootstrap data by scanning ytInitialData and page source.
   * @param signal - Optional AbortSignal to cancel resolution.
   * @returns A resolution object with status, bootstrap data (if ready), and reason.
   */
  async resolve(signal?: AbortSignal): Promise<ChatBootstrapResolution> {
    let lastResult: ChatBootstrapResult | null = null;

    for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
      throwIfAborted(signal);

      const result = await bootstrapChatSession(signal);
      if (result.status === 'ready') {
        return {
          status: 'ready',
          bootstrap: result.data,
          reason: 'Chat bootstrap resolved successfully',
        };
      }

      lastResult = result;
      if (attempt < BOOTSTRAP_MAX_ATTEMPTS) {
        log.debug(
          `Bootstrap attempt ${attempt}/${BOOTSTRAP_MAX_ATTEMPTS} — ${result.status}: ${result.reason}`
        );
        await sleep(BOOTSTRAP_RETRY_DELAY_MS, signal);
      }
    }

    return {
      status: lastResult?.status ?? 'retryable',
      reason: lastResult?.reason ?? 'Chat bootstrap did not become available',
    };
  }

  /**
   * Clears cached bootstrap data to force re-resolution on next access.
   * @param signal - Optional AbortSignal to cancel resolution.
   * @returns The bootstrap data if resolution succeeds, or null.
   */
  async refresh(signal?: AbortSignal): Promise<ChatBootstrapData | null> {
    const resolution = await this.resolve(signal);

    if (resolution.status !== 'ready' || !resolution.bootstrap) {
      log.warn('Failed to refresh chat bootstrap:', resolution.reason);
      return null;
    }

    return resolution.bootstrap;
  }

  /**
   * Logs a bootstrap resolution failure reason.
   * @param resolution - The resolution object containing status and reason.
   */
  logFailure(resolution: ChatBootstrapResolution): void {
    if (resolution.status === 'waiting') {
      log.info(`Chat bootstrap waiting — stream not yet started (${resolution.reason})`);
      return;
    }
    if (resolution.status === 'retryable') {
      log.warn(
        `Chat bootstrap was retryable after ${BOOTSTRAP_MAX_ATTEMPTS} attempts: ${resolution.reason}`
      );
      return;
    }

    log.warn('Chat source is unavailable:', resolution.reason);
  }
}
