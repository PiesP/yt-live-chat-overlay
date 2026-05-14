import { sleep, throwIfAborted } from '@core/dom';
import { createLogger } from '@core/logging';
import type { ChatBootstrapData, ChatBootstrapResult } from '@core/youtubei-chat';
import { bootstrapChatSession } from '@core/youtubei-chat';

const log = createLogger('BootstrapResolver');

const BOOTSTRAP_ATTEMPTS = 8;
const BOOTSTRAP_MAX_UNAVAILABLE_RETRIES = 4;

export interface ChatBootstrapResolution {
  status: ChatBootstrapResult['status'];
  bootstrap?: ChatBootstrapData;
  reason: string;
}

export class BootstrapResolver {
  async resolve(signal?: AbortSignal): Promise<ChatBootstrapResolution> {
    let lastRetryReason = 'Chat bootstrap did not become available';
    let unavailableRetries = 0;

    for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
      throwIfAborted(signal);

      const result = await bootstrapChatSession(signal);
      if (result.status === 'ready') {
        return {
          status: 'ready',
          bootstrap: result.data,
          reason: 'Chat bootstrap resolved successfully',
        };
      }

      if (result.status === 'unavailable') {
        // SPA navigation: YouTube may not have updated window globals yet.
        // Retry with exponential backoff before giving up.
        unavailableRetries++;
        if (unavailableRetries > BOOTSTRAP_MAX_UNAVAILABLE_RETRIES) {
          return {
            status: 'unavailable',
            reason: result.reason,
          };
        }

        lastRetryReason = result.reason;
        log.debug(
          `Bootstrap unavailable (retry ${unavailableRetries}/${BOOTSTRAP_MAX_UNAVAILABLE_RETRIES}): ${result.reason}`
        );
      } else {
        lastRetryReason = result.reason;
      }

      // Exponential backoff: 500ms, 1000ms, 2000ms, 4000ms (cap 4000ms)
      if (attempt < BOOTSTRAP_ATTEMPTS) {
        const backoffDelay = 500 * 2 ** (attempt - 1);
        await sleep(Math.min(backoffDelay, 4000), signal);
      }
    }

    return {
      status: 'retryable',
      reason: lastRetryReason,
    };
  }

  async refresh(signal?: AbortSignal): Promise<ChatBootstrapData | null> {
    const resolution = await this.resolve(signal);

    if (resolution.status !== 'ready' || !resolution.bootstrap) {
      log.warn('Failed to refresh chat bootstrap:', resolution.reason);
      return null;
    }

    return resolution.bootstrap;
  }

  logFailure(resolution: Exclude<ChatBootstrapResolution, { status: 'ready' }>): void {
    if (resolution.status === 'retryable') {
      log.warn(
        `Chat bootstrap was retryable after ${BOOTSTRAP_ATTEMPTS} attempts: ${resolution.reason}`
      );
      return;
    }

    log.warn('Chat source is unavailable:', resolution.reason);
  }
}
